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

const instrumentationName = "github.com/digiform/observability-go/amqp"

// RetryCountHeader tracks redelivery attempts. AMQP has no standard retry
// counter — `redelivered` is a boolean, not a count — so it is maintained here.
const RetryCountHeader = "x-retry-count"

// Consumer instruments message handling.
type Consumer struct {
	tracer trace.Tracer

	processed  metric.Int64Counter
	duration   metric.Float64Histogram
	messageAge metric.Float64Histogram
	dlq        metric.Int64Counter
}

// NewConsumer builds an instrumented consumer.
func NewConsumer() (*Consumer, error) {
	meter := otel.Meter(instrumentationName)

	processed, err := meter.Int64Counter("messaging.process.messages",
		metric.WithDescription("Messages processed, by destination and outcome."))
	if err != nil {
		return nil, fmt.Errorf("amqp: create process counter: %w", err)
	}
	duration, err := meter.Float64Histogram("messaging.process.duration",
		metric.WithDescription("Time spent handling a message."),
		metric.WithUnit("s"))
	if err != nil {
		return nil, fmt.Errorf("amqp: create process histogram: %w", err)
	}
	// The metric no other signal gives you. Queue depth says there is a backlog;
	// message age says how STALE the data your consumers are acting on is. A
	// short queue of very old messages and a long queue of fresh ones are
	// completely different incidents, and depth alone cannot tell them apart.
	messageAge, err := meter.Float64Histogram("messaging.message.age",
		metric.WithDescription("Time from publish to consume."),
		metric.WithUnit("s"))
	if err != nil {
		return nil, fmt.Errorf("amqp: create message age histogram: %w", err)
	}
	dlq, err := meter.Int64Counter("messaging.dlq.messages",
		metric.WithDescription("Messages routed to a dead-letter queue."))
	if err != nil {
		return nil, fmt.Errorf("amqp: create dlq counter: %w", err)
	}

	return &Consumer{
		tracer:     otel.Tracer(instrumentationName),
		processed:  processed,
		duration:   duration,
		messageAge: messageAge,
		dlq:        dlq,
	}, nil
}

// Handler processes one delivery.
type Handler func(ctx context.Context, delivery amqp091.Delivery) error

// Process wraps a handler with a consumer span linked to the producer.
//
// # Why a LINK and not a parent-child relationship
//
// The upstream context is extracted and attached as a trace LINK, and the span
// is started from context.Background() so it becomes the root of a NEW trace.
// Three reasons, each of which has bitten real systems:
//
//  1. Unbounded duration. A message sitting in a queue for six hours would
//     produce a "six-hour trace" whose latency is meaningless and which breaks
//     every duration-based query and SLO you have.
//  2. Fan-out. One message delivered to N queues becomes N ever-growing
//     branches of a single trace, instead of N clean, independently readable
//     traces.
//  3. Retention. A consume that happens long after the publish would append to
//     a trace whose earlier blocks may already be compacted away, leaving a
//     fragment with a dangling parent. A link degrades gracefully — the
//     consumer trace stays complete and useful on its own — whereas parenthood
//     does not.
//
// Use parent-child ONLY for bounded RPC-over-RabbitMQ (reply_to +
// correlation_id, sub-second round trips).
func (c *Consumer) Process(delivery amqp091.Delivery, queue string, handler Handler) error {
	// Extract the producer's context. This is NOT passed to Start — see below.
	upstream := otel.GetTextMapPropagator().Extract(
		context.Background(), HeaderCarrier(delivery.Headers))

	attrs := []attribute.KeyValue{
		semconv.MessagingSystemRabbitmq,
		semconv.MessagingOperationTypeProcess,
		semconv.MessagingDestinationName(queue),
		attribute.String("messaging.rabbitmq.destination.routing_key", delivery.RoutingKey),
		attribute.Int("messaging.message.body.size", len(delivery.Body)),
		attribute.Bool("messaging.rabbitmq.message.redelivered", delivery.Redelivered),
		attribute.Int(RetryCountHeader, retryCount(delivery.Headers)),
	}
	if delivery.MessageId != "" {
		attrs = append(attrs, semconv.MessagingMessageID(delivery.MessageId))
	}

	// context.Background(), NOT upstream. Passing `upstream` here would silently
	// restore parent-child semantics and reintroduce all three problems above.
	// This line is the entire decision — do not "simplify" it.
	ctx, span := c.tracer.Start(context.Background(), queue+" process",
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(attrs...),
		trace.WithLinks(trace.LinkFromContext(upstream)))
	defer span.End()

	// Record how stale this message is. Uses our own header rather than AMQP's
	// Timestamp, which brokers and shovels rewrite.
	if age, ok := messageAge(delivery.Headers); ok {
		c.messageAge.Record(ctx, age.Seconds(),
			metric.WithAttributes(semconv.MessagingDestinationName(queue)))
		span.SetAttributes(attribute.Float64("messaging.message.age_seconds", age.Seconds()))
	}

	start := time.Now()
	err := handler(ctx, delivery)
	elapsed := time.Since(start).Seconds()

	outcome := "ok"
	if err != nil {
		outcome = "error"
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}

	metricAttrs := metric.WithAttributes(
		semconv.MessagingDestinationName(queue),
		attribute.String("outcome", outcome),
	)
	c.processed.Add(ctx, 1, metricAttrs)
	c.duration.Record(ctx, elapsed, metricAttrs)

	return err
}

// RecordDLQ reports a message that has been dead-lettered.
//
// The DLQ is simultaneously where the log→trace link matters most and where the
// original trace is most likely to have aged out, so the originating trace id is
// recorded as an attribute rather than relied upon as a span relationship.
func (c *Consumer) RecordDLQ(ctx context.Context, queue string, headers amqp091.Table) string {
	originTraceID := trace.SpanContextFromContext(
		otel.GetTextMapPropagator().Extract(context.Background(), HeaderCarrier(headers)),
	).TraceID()

	origin := ""
	if originTraceID.IsValid() {
		origin = originTraceID.String()
	}

	c.dlq.Add(ctx, 1, metric.WithAttributes(
		semconv.MessagingDestinationName(queue)))

	if span := trace.SpanFromContext(ctx); span.IsRecording() && origin != "" {
		span.SetAttributes(attribute.String("messaging.origin_trace_id", origin))
	}
	return origin
}

// retryCount reads the retry header, tolerating the several integer types AMQP
// clients use.
func retryCount(headers amqp091.Table) int {
	switch v := headers[RetryCountHeader].(type) {
	case int:
		return v
	case int32:
		return int(v)
	case int64:
		return int(v)
	default:
		return 0
	}
}

func messageAge(headers amqp091.Table) (time.Duration, bool) {
	var publishedAt int64
	switch v := headers[PublishedAtHeader].(type) {
	case int64:
		publishedAt = v
	case int32:
		publishedAt = int64(v)
	case int:
		publishedAt = int64(v)
	default:
		return 0, false
	}
	if publishedAt <= 0 {
		return 0, false
	}
	return time.Since(time.Unix(0, publishedAt)), true
}
