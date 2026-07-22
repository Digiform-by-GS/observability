package observability

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// Tracer returns a named tracer from the global provider — the analogue of the
// Node package's getTracer().
//
// These read the global providers rather than the Observability struct, so
// packages deep in your service can obtain a tracer without threading the
// struct through every constructor. They are safe to call before New(): you get
// a no-op that starts working once New() registers the real providers.
func Tracer(name string, opts ...trace.TracerOption) trace.Tracer {
	return otel.Tracer(name, opts...)
}

// Meter returns a named meter from the global provider.
//
// Create instruments once at package or struct level, never per request, and
// keep attribute values low-cardinality — every distinct combination is a
// separate series, and Mimir now rejects writes past the configured limits.
func Meter(name string, opts ...metric.MeterOption) metric.Meter {
	return otel.Meter(name, opts...)
}
