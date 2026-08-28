// Package chix wires go-chi to OpenTelemetry with a span name the shared
// platform can afford.
//
// See package muxx for why span naming is a platform-wide concern rather than a
// per-service preference: unbounded or collapsed names fill Mimir, and Mimir
// rejects metric writes for every tenant when it fills.
//
// chi's specific trap is that otelchi names spans after the route alone unless
// told otherwise, so GET /orders and POST /orders share one span name and one
// set of series. http.method is recorded as a span attribute but is not one of
// the platform's span-metrics dimensions, so it never reaches the metric labels
// and there is no way to separate them afterwards.
package chix

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/riandyrn/otelchi"
)

// Middleware returns chi middleware that names server spans "{method} {route}"
// - "GET /orders/{id}".
//
// Pass the router itself as routes: otelchi needs it to resolve the route
// template, and without it span names fall back to the concrete path, which is
// unbounded.
//
//	r := chi.NewRouter()
//	r.Use(chix.Middleware("orders", r))
func Middleware(service string, routes chi.Routes, opts ...otelchi.Option) func(http.Handler) http.Handler {
	base := []otelchi.Option{
		otelchi.WithChiRoutes(routes),
		otelchi.WithRequestMethodInSpanName(true),
	}
	return otelchi.Middleware(service, append(base, opts...)...)
}
