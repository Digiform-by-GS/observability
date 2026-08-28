// Package muxx wires gorilla/mux to OpenTelemetry with a span name the shared
// platform can afford.
//
// Server span names become metric label values in Tempo's span-metrics
// generator, and every distinct name multiplies by the latency histogram's
// bucket count. Unbounded names therefore do not degrade the offending service
// - they fill Mimir, and Mimir then rejects metric writes for EVERY tenant on
// the platform. One team's routing mistake takes out everyone's dashboards.
//
// gorilla/mux is the worst of the supported routers on this point and the
// reason this package exists. otelmux's default formatter returns the route
// alone, so GET /orders and POST /orders collapse into one span name and share
// a single set of rate, error, and latency series - you cannot tell a read from
// a write. There is no upstream option to fix it: unlike otelchi, which has
// WithRequestMethodInSpanName, otelmux requires the caller to supply a
// formatter by hand. Every caller, correctly, every time. That is what this
// package removes.
package muxx

import (
	"net/http"

	"github.com/gorilla/mux"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gorilla/mux/otelmux"
)

// Middleware returns gorilla/mux middleware that names server spans
// "{method} {route}" - "GET /orders/{id}" - matching OpenTelemetry's HTTP
// convention and the naming the Node stack produces.
//
// Extra otelmux options are appended, so a caller can add a filter without
// giving up the naming:
//
//	r.Use(muxx.Middleware("orders", otelmux.WithFilter(skipWebsockets)))
//
// A later WithSpanNameFormatter will win over the default, which is intended:
// the escape hatch has to be real. If you override it, keep the name a route
// template - never a concrete path.
func Middleware(service string, opts ...otelmux.Option) mux.MiddlewareFunc {
	base := []otelmux.Option{
		otelmux.WithSpanNameFormatter(func(route string, r *http.Request) string {
			// A request that matches no route has an empty template. Falling
			// back to r.URL.Path here would be the cardinality bug this package
			// exists to prevent, since 404 scanners walk arbitrary URLs.
			if route == "" {
				return r.Method
			}
			return r.Method + " " + route
		}),
	}
	return otelmux.Middleware(service, append(base, opts...)...)
}
