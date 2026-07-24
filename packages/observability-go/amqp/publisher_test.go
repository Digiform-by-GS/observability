package amqp

import (
	"context"
	"errors"
	"testing"

	amqp091 "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// fakeChannel captures the last published message instead of sending it, and can
// be made to fail on demand.
type fakeChannel struct {
	published amqp091.Publishing
	exchange  string
	key       string
	err       error
}

func (f *fakeChannel) PublishWithContext(_ context.Context, exchange, key string, _, _ bool, msg amqp091.Publishing) error {
	if f.err != nil {
		return f.err
	}
	f.exchange, f.key, f.published = exchange, key, msg
	return nil
}

// The whole point of the producer side: the active span's context must be
// injected into the AMQP headers, or the consumer has nothing to link back to.
func TestPublisherInjectsTraceContext(t *testing.T) {
	setupRecorder(t) // installs tracer provider + TraceContext propagator

	fake := &fakeChannel{}
	pub, err := NewPublisher(fake)
	if err != nil {
		t.Fatalf("NewPublisher: %v", err)
	}

	// Publish from within an active span, as a request handler would.
	tracer := otel.Tracer("test")
	ctx, span := tracer.Start(context.Background(), "handler")
	err = pub.Publish(ctx, "", "orders", amqp091.Publishing{Body: []byte(`{}`)})
	span.End()
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// traceparent must be present and must refer to THIS request's trace.
	tp, ok := fake.published.Headers["traceparent"].(string)
	if !ok || tp == "" {
		t.Fatalf("traceparent header missing or not a string: %v", fake.published.Headers)
	}

	extracted := trace.SpanContextFromContext(
		propagation.TraceContext{}.Extract(context.Background(), HeaderCarrier(fake.published.Headers)))
	if extracted.TraceID() != span.SpanContext().TraceID() {
		t.Errorf("injected trace id = %s, want the publishing request's %s",
			extracted.TraceID(), span.SpanContext().TraceID())
	}
}

// The publish-time header is what lets the consumer compute message age. It must
// be set to a positive timestamp.
func TestPublisherStampsPublishTime(t *testing.T) {
	setupRecorder(t)

	fake := &fakeChannel{}
	pub, err := NewPublisher(fake)
	if err != nil {
		t.Fatalf("NewPublisher: %v", err)
	}

	if err := pub.Publish(context.Background(), "", "orders", amqp091.Publishing{}); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	ts, ok := fake.published.Headers[PublishedAtHeader].(int64)
	if !ok || ts <= 0 {
		t.Errorf("%s header = %v, want a positive int64", PublishedAtHeader, fake.published.Headers[PublishedAtHeader])
	}
}

// A producer span must be recorded with PRODUCER kind, so span-metrics can build
// the async view the service graph cannot.
func TestPublisherRecordsProducerSpan(t *testing.T) {
	recorder := setupRecorder(t)

	pub, err := NewPublisher(&fakeChannel{})
	if err != nil {
		t.Fatalf("NewPublisher: %v", err)
	}
	if err := pub.Publish(context.Background(), "", "orders", amqp091.Publishing{}); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("expected one producer span, got %d", len(spans))
	}
	if spans[0].SpanKind() != trace.SpanKindProducer {
		t.Errorf("span kind = %v, want Producer", spans[0].SpanKind())
	}
	if spans[0].Name() != "orders publish" {
		t.Errorf("span name = %q, want %q", spans[0].Name(), "orders publish")
	}
}

func TestPublisherReturnsErrorFromChannel(t *testing.T) {
	recorder := setupRecorder(t)

	fake := &fakeChannel{err: errors.New("broker unreachable")}
	pub, err := NewPublisher(fake)
	if err != nil {
		t.Fatalf("NewPublisher: %v", err)
	}

	if err := pub.Publish(context.Background(), "", "orders", amqp091.Publishing{}); err == nil {
		t.Fatal("expected Publish to return the channel error")
	}

	// The span must record the failure, not silently report success.
	span := recorder.Ended()[0]
	if span.Status().Code == 0 {
		t.Error("span status was left unset on a failed publish")
	}
}

// Compile-time assertion that the fake satisfies the interface the publisher takes.
var _ Channel = (*fakeChannel)(nil)
