package amqp

import (
	"context"
	"fmt"
	"time"

	amqp091 "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.30.0"
	"go.opentelemetry.io/otel/trace"
)

// PublishedAtHeader carries the publish time so the consumer can compute
// message age. AMQP's own Timestamp field is optional and frequently rewritten
// by brokers and shovels, so age is tracked in an explicit header instead.
const PublishedAtHeader = "x-published-at-unix-nano"

// Publisher wraps an AMQP channel with tracing and metrics.
type Publisher struct {
	ch     *amqp091.Channel
	tracer trace.Tracer

	published metric.Int64Counter
	duration  metric.Float64Histogram
}

// NewPublisher instruments an existing channel.
func NewPublisher(ch *amqp091.Channel) (*Publisher, error) {
	meter := otel.Meter(instrumentationName)

	published, err := meter.Int64Counter("messaging.publish.messages",
		metric.WithDescription("Messages published, by destination."))
	if err != nil {
		return nil, fmt.Errorf("amqp: create publish counter: %w", err)
	}
	duration, err := meter.Float64Histogram("messaging.publish.duration",
		metric.WithDescription("Time to publish a message."),
		metric.WithUnit("s"))
	if err != nil {
		return nil, fmt.Errorf("amqp: create publish histogram: %w", err)
	}

	return &Publisher{
		ch:        ch,
		tracer:    otel.Tracer(instrumentationName),
		published: published,
		duration:  duration,
	}, nil
}

// Publish sends a message with the active trace context injected into its
// headers.
//
// The span is PRODUCER-kind and named "<destination> publish", following the
// OTel messaging conventions — Tempo's span-metrics then group publishes by
// destination without further configuration.
func (p *Publisher) Publish(ctx context.Context, exchange, routingKey string, msg amqp091.Publishing) error {
	destination := exchange
	if destination == "" {
		// Default exchange: the routing key IS the queue name, so that is the
		// meaningful destination to report.
		destination = routingKey
	}

	attrs := []attribute.KeyValue{
		semconv.MessagingSystemRabbitmq,
		semconv.MessagingOperationTypeSend,
		semconv.MessagingDestinationName(destination),
		attribute.String("messaging.rabbitmq.destination.routing_key", routingKey),
		attribute.Int("messaging.message.body.size", len(msg.Body)),
	}
	if msg.MessageId != "" {
		attrs = append(attrs, semconv.MessagingMessageID(msg.MessageId))
	}

	ctx, span := p.tracer.Start(ctx, destination+" publish",
		trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(attrs...))
	defer span.End()

	if msg.Headers == nil {
		msg.Headers = amqp091.Table{}
	}
	// Inject AFTER starting the span, so the propagated context refers to this
	// producer span rather than its parent.
	otel.GetTextMapPropagator().Inject(ctx, HeaderCarrier(msg.Headers))
	msg.Headers[PublishedAtHeader] = time.Now().UnixNano()

	start := time.Now()
	err := p.ch.PublishWithContext(ctx, exchange, routingKey, false, false, msg)
	elapsed := time.Since(start).Seconds()

	metricAttrs := metric.WithAttributes(
		semconv.MessagingDestinationName(destination),
		attribute.Bool("error", err != nil),
	)
	p.published.Add(ctx, 1, metricAttrs)
	p.duration.Record(ctx, elapsed, metricAttrs)

	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return fmt.Errorf("amqp: publish to %s: %w", destination, err)
	}

	// NOTE: with publisher confirms enabled, do NOT end the span here — wait for
	// the confirmation, or the span reports success for a message the broker
	// went on to reject. This publisher does not use confirms; if you enable
	// them, move span.End() after the confirm arrives.
	return nil
}
