package muxx_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gorilla/mux/otelmux"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/Digiform-by-GS/observability/packages/observability-go/httpx/muxx"
)

// recordSpanNames drives real requests through a real router and returns the
// span names that were actually recorded. Asserting on the recorded name rather
// than on the formatter is the point: the formatter can be correct while the
// wiring that installs it is not.
func recordSpanNames(t *testing.T, requests [][2]string) []string {
	t.Helper()

	sr := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	r := mux.NewRouter()
	r.Use(muxx.Middleware("test", otelmux.WithTracerProvider(tp)))
	ok := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }
	r.HandleFunc("/orders/{id}", ok).Methods(http.MethodGet)
	r.HandleFunc("/orders", ok).Methods(http.MethodGet, http.MethodPost)

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

// The whole reason this package exists. otelmux's default formatter returns the
// route without the method, and there is no upstream option to change that.
func TestSpanNameIsMethodPlusRouteTemplate(t *testing.T) {
	names := recordSpanNames(t, [][2]string{{http.MethodGet, "/orders/42"}})

	if len(names) != 1 {
		t.Fatalf("expected 1 span, got %d: %v", len(names), names)
	}
	if names[0] != "GET /orders/{id}" {
		t.Errorf("span name = %q, want %q", names[0], "GET /orders/{id}")
	}
}

// Without the method, GET and POST on one route share a single span name and
// therefore one set of rate/error/latency series - a read is indistinguishable
// from a write on every dashboard, with no way to separate them afterwards
// because http.method is not a span-metrics dimension on this platform.
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
	for _, want := range []string{"GET /orders", "POST /orders"} {
		if !unique[want] {
			t.Errorf("missing span name %q, got %v", want, names)
		}
	}
}

// The failure that fills Mimir: a concrete id reaching the span name means one
// new series set per distinct URL, growing without bound until writes are
// rejected for every tenant on the platform.
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
	for _, n := range names {
		for _, id := range []string{"42", "99"} {
			if containsToken(n, id) {
				t.Errorf("span name %q contains the concrete id %q", n, id)
			}
		}
	}
}

// An unmatched route has no template. Falling back to the concrete path there
// would reintroduce unbounded names via 404 scanners walking arbitrary URLs.
func TestUnmatchedRouteDoesNotLeakThePath(t *testing.T) {
	names := recordSpanNames(t, [][2]string{
		{http.MethodGet, "/no/such/route/8f2a1c"},
	})

	for _, n := range names {
		if containsToken(n, "8f2a1c") {
			t.Errorf("span name %q leaked an unmatched concrete path", n)
		}
	}
}

// A caller's own options must still be able to reach otelmux, or the escape
// hatch is fiction and the next unusual requirement forces a fork.
func TestCallerOptionsAreApplied(t *testing.T) {
	sr := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	r := mux.NewRouter()
	r.Use(muxx.Middleware("test",
		otelmux.WithTracerProvider(tp),
		otelmux.WithFilter(func(*http.Request) bool { return false }),
	))
	r.HandleFunc("/orders", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}).Methods(http.MethodGet)

	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL+"/orders", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_ = resp.Body.Close()

	if got := len(sr.Ended()); got != 0 {
		t.Errorf("filter was ignored: recorded %d span(s), want 0", got)
	}
}

func containsToken(s, token string) bool {
	for i := 0; i+len(token) <= len(s); i++ {
		if s[i:i+len(token)] == token {
			return true
		}
	}
	return false
}
