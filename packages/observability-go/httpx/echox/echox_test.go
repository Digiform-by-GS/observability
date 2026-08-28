package echox_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/Digiform-by-GS/observability/packages/observability-go/httpx/echox"
)

func recordSpanNames(t *testing.T, requests [][2]string) []string {
	t.Helper()

	sr := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	e := echo.New()
	e.HideBanner = true
	e.Use(echox.Middleware("test", otelecho.WithTracerProvider(tp)))
	ok := func(c echo.Context) error { return c.NoContent(http.StatusOK) }
	e.GET("/orders/:id", ok)
	e.GET("/orders", ok)
	e.POST("/orders", ok)

	srv := httptest.NewServer(e)
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

// otelecho needs no help today. As with ginx, the value of this test is that it
// fails if a future release changes the default.
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
