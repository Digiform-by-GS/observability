package observability

import (
	"context"
	"net/http"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// Guard for the single most common Go OpenTelemetry defect: Go's default
// propagator is a no-op, so without an explicit SetTextMapPropagator every
// service starts a brand-new trace. Individual spans look perfect and nothing
// ever errors — the traces simply never join across services. If someone
// removes that line in New(), this test fails instead of the failure surfacing
// weeks later as "why is Keycloak in its own trace?".
func TestNewSetsTraceContextPropagator(t *testing.T) {
	ctx := context.Background()
	t.Setenv("OTEL_SERVICE_NAME", "propagator-test")

	obs, err := New(ctx)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = obs.Shutdown(shutdownCtx)
	})

	// A no-op propagator injects nothing, so the absence of traceparent is the
	// exact symptom being guarded against.
	spanCtx := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    trace.TraceID{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10},
		SpanID:     trace.SpanID{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08},
		TraceFlags: trace.FlagsSampled,
	})
	carrier := propagation.HeaderCarrier(http.Header{})
	otel.GetTextMapPropagator().Inject(
		trace.ContextWithSpanContext(ctx, spanCtx), carrier)

	if got := carrier.Get("traceparent"); got == "" {
		t.Fatal("traceparent header was not injected — the global propagator is a no-op, " +
			"so cross-service traces will never join")
	}

	// Round-trip it: extraction must recover the same trace id, or context
	// arrives at the next service and is silently dropped.
	extracted := trace.SpanContextFromContext(
		otel.GetTextMapPropagator().Extract(context.Background(), carrier))
	if extracted.TraceID() != spanCtx.TraceID() {
		t.Errorf("extracted trace id = %s, want %s", extracted.TraceID(), spanCtx.TraceID())
	}
}

// Baggage travels alongside trace context; it is half of the composite
// propagator and easy to drop when editing that line.
func TestNewSetsBaggagePropagator(t *testing.T) {
	ctx := context.Background()
	t.Setenv("OTEL_SERVICE_NAME", "baggage-test")

	obs, err := New(ctx)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = obs.Shutdown(shutdownCtx)
	})

	fields := otel.GetTextMapPropagator().Fields()
	var hasBaggage bool
	for _, f := range fields {
		if f == "baggage" {
			hasBaggage = true
		}
	}
	if !hasBaggage {
		t.Errorf("propagator fields = %v, want them to include \"baggage\"", fields)
	}
}

func TestNewFailsWithoutServiceName(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "")

	if _, err := New(context.Background()); err == nil {
		t.Fatal("expected New to return an error without a service name")
	}
}
