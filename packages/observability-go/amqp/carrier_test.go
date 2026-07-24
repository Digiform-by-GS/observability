package amqp

import (
	"context"
	"sort"
	"testing"

	amqp091 "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// The carrier is the single point where cross-service correlation over the
// broker can silently break, so it is tested directly rather than only through
// an integration test.

func TestCarrierRoundTripsTraceContext(t *testing.T) {
	prop := propagation.TraceContext{}

	spanCtx := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    trace.TraceID{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10},
		SpanID:     trace.SpanID{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08},
		TraceFlags: trace.FlagsSampled,
	})

	headers := amqp091.Table{}
	prop.Inject(trace.ContextWithSpanContext(context.Background(), spanCtx), HeaderCarrier(headers))

	if _, ok := headers["traceparent"]; !ok {
		t.Fatalf("traceparent was not injected into the AMQP headers, got %v", headers)
	}

	extracted := trace.SpanContextFromContext(
		prop.Extract(context.Background(), HeaderCarrier(headers)))

	if extracted.TraceID() != spanCtx.TraceID() {
		t.Errorf("trace id = %s, want %s", extracted.TraceID(), spanCtx.TraceID())
	}
	if extracted.SpanID() != spanCtx.SpanID() {
		t.Errorf("span id = %s, want %s", extracted.SpanID(), spanCtx.SpanID())
	}
	if !extracted.IsSampled() {
		t.Error("sampled flag was lost in transit")
	}
}

// AMQP headers are map[string]interface{}: any AMQP type can appear. A producer
// outside your control writing a numeric or nil header must not panic the
// consumer — it should simply look like no trace context is present.
func TestCarrierGetToleratesNonStringValues(t *testing.T) {
	headers := HeaderCarrier{
		"traceparent": 42,             // wrong type entirely
		"tracestate":  nil,            // nil value
		"baggage":     []byte("k=v"),  // byte slice, which some clients emit
		"ok":          "plain-string", //nolint:gofmt // aligned for readability
	}

	for _, tc := range []struct{ key, want string }{
		{"traceparent", ""},
		{"tracestate", ""},
		{"baggage", "k=v"},
		{"ok", "plain-string"},
		{"absent", ""},
	} {
		if got := headers.Get(tc.key); got != tc.want {
			t.Errorf("Get(%q) = %q, want %q", tc.key, got, tc.want)
		}
	}
}

// A message from a producer that never heard of OpenTelemetry must extract to
// an invalid span context, not an error or panic.
func TestExtractFromForeignMessageIsInvalidNotFatal(t *testing.T) {
	prop := propagation.TraceContext{}
	headers := HeaderCarrier{"x-retry-count": int32(3)}

	sc := trace.SpanContextFromContext(prop.Extract(context.Background(), headers))
	if sc.IsValid() {
		t.Errorf("expected an invalid span context from a message with no trace headers, got %v", sc)
	}
}

func TestCarrierKeys(t *testing.T) {
	headers := HeaderCarrier{"traceparent": "x", "baggage": "y"}

	keys := headers.Keys()
	sort.Strings(keys)

	if len(keys) != 2 || keys[0] != "baggage" || keys[1] != "traceparent" {
		t.Errorf("Keys() = %v, want [baggage traceparent]", keys)
	}
}

func TestCarrierSetWritesThrough(t *testing.T) {
	// Set must mutate the caller's table, since the publisher passes its own
	// header map in and then publishes it.
	headers := amqp091.Table{"existing": "kept"}
	HeaderCarrier(headers).Set("traceparent", "00-abc-def-01")

	if headers["traceparent"] != "00-abc-def-01" {
		t.Errorf("Set did not write through to the underlying table: %v", headers)
	}
	if headers["existing"] != "kept" {
		t.Error("Set clobbered an unrelated header")
	}
}
