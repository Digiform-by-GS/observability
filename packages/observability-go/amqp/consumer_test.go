package amqp

import (
	"context"
	"errors"
	"testing"

	amqp091 "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// setupRecorder installs a real tracer provider that records spans in memory,
// plus the W3C propagator, and restores the globals afterwards.
func setupRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()

	recorder := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))

	prevTP := otel.GetTracerProvider()
	prevProp := otel.GetTextMapPropagator()
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	t.Cleanup(func() {
		otel.SetTracerProvider(prevTP)
		otel.SetTextMapPropagator(prevProp)
	})
	return recorder
}

// upstreamHeaders builds an AMQP header table carrying a producer's trace
// context, as a real publisher would leave it.
func upstreamHeaders(t *testing.T) (amqp091.Table, trace.TraceID) {
	t.Helper()

	producerCtx := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    trace.TraceID{0xaa, 0xbb, 0xcc, 0xdd, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c},
		SpanID:     trace.SpanID{0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88},
		TraceFlags: trace.FlagsSampled,
	})
	headers := amqp091.Table{}
	propagation.TraceContext{}.Inject(
		trace.ContextWithSpanContext(context.Background(), producerCtx),
		HeaderCarrier(headers))
	return headers, producerCtx.TraceID()
}

// This is THE guard for the project's riskiest design decision. The consumer
// must start a NEW ROOT trace carrying a LINK to the producer — not continue the
// producer's trace as a parent-child child span. If someone "simplifies"
// consumer.go by passing the extracted upstream context to tracer.Start, this
// test fails: the consumer span would share the producer's trace id and carry no
// link. The CLAUDE.md comment warns a human; this fails CI.
func TestConsumerStartsLinkedRootTrace(t *testing.T) {
	recorder := setupRecorder(t)
	headers, producerTraceID := upstreamHeaders(t)

	consumer, err := NewConsumer()
	if err != nil {
		t.Fatalf("NewConsumer: %v", err)
	}

	delivery := amqp091.Delivery{Headers: headers, RoutingKey: "orders", Body: []byte(`{}`)}
	if err := consumer.Process(delivery, "orders", func(context.Context, amqp091.Delivery) error {
		return nil
	}); err != nil {
		t.Fatalf("Process: %v", err)
	}

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("expected exactly one consumer span, got %d", len(spans))
	}
	span := spans[0]

	if span.SpanKind() != trace.SpanKindConsumer {
		t.Errorf("span kind = %v, want Consumer", span.SpanKind())
	}

	// New root trace: the consumer must NOT be in the producer's trace.
	if span.SpanContext().TraceID() == producerTraceID {
		t.Error("consumer span shares the producer's trace id — it was made a child " +
			"instead of a linked root trace, reintroducing unbounded/ fan-out/ retention problems")
	}

	// ...but it must LINK to the producer, or the two traces can never be
	// associated at all.
	links := span.Links()
	if len(links) != 1 {
		t.Fatalf("expected exactly one link to the producer, got %d", len(links))
	}
	if got := links[0].SpanContext.TraceID(); got != producerTraceID {
		t.Errorf("link trace id = %s, want the producer's %s", got, producerTraceID)
	}
}

func TestConsumerRecordsHandlerError(t *testing.T) {
	recorder := setupRecorder(t)
	headers, _ := upstreamHeaders(t)

	consumer, err := NewConsumer()
	if err != nil {
		t.Fatalf("NewConsumer: %v", err)
	}

	wantErr := errors.New("handler blew up")
	delivery := amqp091.Delivery{Headers: headers, RoutingKey: "orders"}
	gotErr := consumer.Process(delivery, "orders", func(context.Context, amqp091.Delivery) error {
		return wantErr
	})

	if !errors.Is(gotErr, wantErr) {
		t.Errorf("Process returned %v, want it to propagate %v", gotErr, wantErr)
	}

	span := recorder.Ended()[0]
	if span.Status().Code != codes.Error {
		t.Errorf("span status = %v, want Error", span.Status().Code)
	}
}

// A message from a producer that never set trace context must still produce a
// clean consumer trace — just one with a link to nothing valid.
func TestConsumerHandlesMessageWithoutUpstreamContext(t *testing.T) {
	recorder := setupRecorder(t)

	consumer, err := NewConsumer()
	if err != nil {
		t.Fatalf("NewConsumer: %v", err)
	}

	delivery := amqp091.Delivery{Headers: amqp091.Table{"x-retry-count": int32(2)}, RoutingKey: "orders"}
	if err := consumer.Process(delivery, "orders", func(context.Context, amqp091.Delivery) error {
		return nil
	}); err != nil {
		t.Fatalf("Process: %v", err)
	}

	span := recorder.Ended()[0]
	if !span.SpanContext().IsValid() {
		t.Error("consumer span should still be a valid, recordable span")
	}
	if span.SpanKind() != trace.SpanKindConsumer {
		t.Errorf("span kind = %v, want Consumer", span.SpanKind())
	}
}
