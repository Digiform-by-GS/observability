package ginx_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/Digiform-by-GS/observability/packages/observability-go/httpx/ginx"
)

func recordSpanNames(t *testing.T, requests [][2]string) []string {
	t.Helper()

	sr := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(ginx.Middleware("test", otelgin.WithTracerProvider(tp)))
	ok := func(c *gin.Context) { c.Status(http.StatusOK) }
	r.GET("/orders/:id", ok)
	r.GET("/orders", ok)
	r.POST("/orders", ok)

	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	for _, rq := range requests {
		req, err := http.NewRequestWithContext(context.Background(), rq[0], srv.URL+rq[1], nil)
		if err != nil {
			t.Fatalf("build request: %v", err)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", rq[0], rq[1], err)
		}
		_ = resp.Body.Close()
	}

	names := make([]string, 0, len(requests))
	for _, s := range sr.Ended() {
		names = append(names, s.Name())
	}
	return names
}

// otelgin needs no help today. This test is the reason the package exists
// anyway: it fails if a future otelgin changes that default, which is exactly
// the kind of drift nobody would otherwise notice until Mimir filled up.
func TestSpanNameIsMethodPlusRouteTemplate(t *testing.T) {
	names := recordSpanNames(t, [][2]string{{http.MethodGet, "/orders/42"}})

	if len(names) != 1 {
		t.Fatalf("expected 1 span, got %d: %v", len(names), names)
	}
	if names[0] != "GET /orders/:id" {
		t.Errorf("span name = %q, want %q", names[0], "GET /orders/:id")
	}
}

func TestMethodsOnSameRouteGetDistinctSpanNames(t *testing.T) {
	names := recordSpanNames(t, [][2]string{
		{http.MethodGet, "/orders"},
		{http.MethodPost, "/orders"},
	})

	unique := map[string]bool{}
	for _, n := range names {
		unique[n] = true
	}
	if len(unique) != 2 {
		t.Fatalf("GET and POST collapsed into %d name(s): %v", len(unique), names)
	}
}

func TestConcretePathNeverReachesSpanName(t *testing.T) {
	names := recordSpanNames(t, [][2]string{
		{http.MethodGet, "/orders/42"},
		{http.MethodGet, "/orders/99"},
	})

	unique := map[string]bool{}
	for _, n := range names {
		unique[n] = true
	}
	if len(unique) != 1 {
		t.Fatalf("distinct ids produced %d span names, want 1: %v", len(unique), names)
	}
}
