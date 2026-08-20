package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	amqp091 "github.com/rabbitmq/amqp091-go"

	obsamqp "github.com/Digiform-by-GS/observability/packages/observability-go/amqp"
)

const (
	ordersQueue = "orders"
	ordersDLQ   = "orders.dlq"
)

// messaging owns the AMQP connection and the instrumented publisher/consumer.
// Optional like the other deps: unset RABBITMQ_URL and the /publish route
// reports itself disabled rather than the service refusing to boot.
type messaging struct {
	conn      *amqp091.Connection
	ch        *amqp091.Channel
	publisher *obsamqp.Publisher
	consumer  *obsamqp.Consumer
	log       *slog.Logger
}

func openMessaging(log *slog.Logger) (*messaging, error) {
	url := os.Getenv("RABBITMQ_URL")
	if url == "" {
		return nil, nil //nolint:nilnil // "not configured" is a valid, non-error state
	}

	conn, err := amqp091.Dial(url)
	if err != nil {
		return nil, fmt.Errorf("dial rabbitmq: %w", err)
	}

	ch, err := conn.Channel()
	if err != nil {
		return nil, errors.Join(fmt.Errorf("open channel: %w", err), conn.Close())
	}

	// Declare the DLQ first, then the main queue configured to dead-letter into
	// it. A message that fails handling lands here rather than being lost or
	// redelivered forever.
	if _, err := ch.QueueDeclare(ordersDLQ, true, false, false, false, nil); err != nil {
		return nil, errors.Join(fmt.Errorf("declare dlq: %w", err), ch.Close(), conn.Close())
	}
	if _, err := ch.QueueDeclare(ordersQueue, true, false, false, false, amqp091.Table{
		"x-dead-letter-exchange":    "",
		"x-dead-letter-routing-key": ordersDLQ,
	}); err != nil {
		return nil, errors.Join(fmt.Errorf("declare queue: %w", err), ch.Close(), conn.Close())
	}

	publisher, err := obsamqp.NewPublisher(ch)
	if err != nil {
		return nil, errors.Join(err, ch.Close(), conn.Close())
	}
	consumer, err := obsamqp.NewConsumer()
	if err != nil {
		return nil, errors.Join(err, ch.Close(), conn.Close())
	}

	return &messaging{conn: conn, ch: ch, publisher: publisher, consumer: consumer, log: log}, nil
}

// publishOrder sends one order message with the active trace context injected.
func (m *messaging) publishOrder(ctx context.Context, orderID string, amount int) error {
	body := fmt.Sprintf(`{"order_id":%q,"amount":%d}`, orderID, amount)
	return m.publisher.Publish(ctx, "", ordersQueue, amqp091.Publishing{
		ContentType:  "application/json",
		MessageId:    orderID,
		DeliveryMode: amqp091.Persistent,
		Body:         []byte(body),
	})
}

// consume runs the consumer loop until ctx is cancelled. Each delivery is
// wrapped in a NEW trace linked to the producer — see Consumer.Process for why.
func (m *messaging) consume(ctx context.Context) error {
	deliveries, err := m.ch.Consume(ordersQueue, "go-service", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("start consuming: %w", err)
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case delivery, ok := <-deliveries:
			if !ok {
				return nil // channel closed
			}
			m.handleDelivery(ctx, delivery)
		}
	}
}

func (m *messaging) handleDelivery(ctx context.Context, delivery amqp091.Delivery) {
	err := m.consumer.Process(delivery, ordersQueue, func(spanCtx context.Context, d amqp091.Delivery) error {
		// A body containing "fail" is the fault-injection hook for the DLQ demo.
		if len(d.Body) > 0 && containsFail(d.Body) {
			return errors.New("simulated processing failure")
		}
		m.log.InfoContext(spanCtx, "order processed",
			slog.String("message_id", d.MessageId),
			slog.Int("body_size", len(d.Body)))
		time.Sleep(20 * time.Millisecond) // pretend to do work
		return nil
	})

	if err != nil {
		// Nack without requeue -> the broker dead-letters it per the queue's
		// x-dead-letter config. Record the DLQ event with the origin trace id.
		origin := m.consumer.RecordDLQ(ctx, ordersDLQ, delivery.Headers)
		m.log.ErrorContext(ctx, "message dead-lettered",
			slog.String("message_id", delivery.MessageId),
			slog.String("origin_trace_id", origin),
			slog.Any("error", err))
		_ = delivery.Nack(false, false)
		return
	}
	_ = delivery.Ack(false)
}

func (m *messaging) Close() error {
	if m == nil {
		return nil
	}
	return errors.Join(m.ch.Close(), m.conn.Close())
}

func containsFail(body []byte) bool {
	const needle = "fail"
	for i := 0; i+len(needle) <= len(body); i++ {
		if string(body[i:i+len(needle)]) == needle {
			return true
		}
	}
	return false
}
