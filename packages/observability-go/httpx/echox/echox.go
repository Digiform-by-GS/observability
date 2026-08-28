// Package echox wires Echo to OpenTelemetry with a span name the shared
// platform can afford.
//
// See package muxx for why span naming is a platform-wide concern rather than a
// per-service preference: unbounded or collapsed names fill Mimir, and Mimir
// rejects metric writes for every tenant when it fills.
//
// Like ginx this is a thin pass-through, because otelecho's default formatter
// already produces "{method} {route}". It exists for uniformity across the four
// routers, and for the span-name test beside it, which fails if an upgrade
// changes that default.
package echox

import (
	"github.com/labstack/echo/v4"
	"go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho"
)

// Middleware returns Echo middleware that names server spans "{method} {route}"
// - "GET /orders/:id".
//
//	e := echo.New()
//	e.Use(echox.Middleware("orders"))
func Middleware(service string, opts ...otelecho.Option) echo.MiddlewareFunc {
	return otelecho.Middleware(service, opts...)
}
