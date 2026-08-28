// Package ginx wires gin to OpenTelemetry with a span name the shared platform
// can afford.
//
// See package muxx for why span naming is a platform-wide concern rather than a
// per-service preference: unbounded or collapsed names fill Mimir, and Mimir
// rejects metric writes for every tenant when it fills.
//
// This package is thinner than muxx and chix because otelgin already names
// spans "{method} {route}". It exists anyway so that the four supported routers
// are wired the same way, with the same one line, and a service author does not
// have to know which routers need help and which do not. The span-name test
// beside this file is the part that matters: it fails if an otelgin upgrade
// changes the default.
package ginx

import (
	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"
)

// Middleware returns gin middleware that names server spans "{method} {route}"
// - "GET /orders/:id".
//
//	r := gin.New()
//	r.Use(ginx.Middleware("orders"))
func Middleware(service string, opts ...otelgin.Option) gin.HandlerFunc {
	return otelgin.Middleware(service, opts...)
}
