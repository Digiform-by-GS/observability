package observability

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// These tests are the regression guard for OTLP auth headers — the mechanism
// clients will use to authenticate against a multi-tenant collector.
//
// The env-var case matters most: New() constructs exporters with explicit
// options (WithEndpointURL), and it is not obvious from the code that
// OTEL_EXPORTER_OTLP_HEADERS still applies. It does, because the exporter's
// own default-option chain reads it — but that is upstream behaviour this
// package merely inherits, so it is asserted here rather than assumed.

// captureServer records the headers of every OTLP request it receives.
type captureServer struct {
	mu       sync.Mutex
	requests map[string]http.Header // path -> headers
	srv      *httptest.Server
}

func newCaptureServer(t *testing.T) *captureServer {
	t.Helper()
	c := &captureServer{requests: map[string]http.Header{}}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		c.requests[r.URL.Path] = r.Header.Clone()
		c.mu.Unlock()
		// 200 with an empty body is a valid empty ExportServiceResponse.
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(c.srv.Close)
	return c
}

func (c *captureServer) headerFor(path string) http.Header {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.requests[path]
}

// exportOneSpan initialises the SDK against the capture server, emits a span,
// and shuts down (which flushes the batcher, producing a real POST).
func exportOneSpan(t *testing.T, c *captureServer, opts ...Option) {
	t.Helper()
	ctx := context.Background()

	all := append([]Option{
		WithServiceName("headers-test"),
		WithEndpoint(c.srv.URL),
		WithoutRuntimeMetrics(),
		WithoutStdoutLogs(),
	}, opts...)

	obs, err := New(ctx, all...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	_, span := Tracer("headers-test").Start(ctx, "probe")
	span.End()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := obs.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
}

func TestOTLPHeadersFromEnvironment(t *testing.T) {
	c := newCaptureServer(t)
	t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer env-token,x-tenant=acme")

	exportOneSpan(t, c)

	h := c.headerFor("/v1/traces")
	if h == nil {
		t.Fatal("no POST to /v1/traces was captured")
	}
	if got := h.Get("Authorization"); got != "Bearer env-token" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer env-token")
	}
	if got := h.Get("X-Tenant"); got != "acme" {
		t.Errorf("X-Tenant = %q, want %q", got, "acme")
	}
}

func TestOTLPHeadersFromOption(t *testing.T) {
	c := newCaptureServer(t)

	exportOneSpan(t, c, WithHeaders(map[string]string{"Authorization": "Bearer code-token"}))

	h := c.headerFor("/v1/traces")
	if h == nil {
		t.Fatal("no POST to /v1/traces was captured")
	}
	if got := h.Get("Authorization"); got != "Bearer code-token" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer code-token")
	}
}

// The mixed case, and a genuine Go/Node divergence worth pinning down.
//
// Upstream otlpconfig.WithHeaders does `cfg.Traces.Headers = headers` — a plain
// assignment. So in Go, WithHeaders REPLACES the entire env-derived header map;
// non-colliding env headers are dropped. The Node exporters merge instead, so
// the same combination there keeps both.
//
// Neither library is wrong, but they are not interchangeable, and the failure
// mode is silent: a client that sets an auth token via env and a tenant header
// via code gets a request missing the token in Go and carrying both in Node.
// The documented rule is therefore "use one mechanism, not both" — and this
// test exists so that if upstream ever switches to merging, we find out from a
// failing test rather than from a client's 401s.
func TestOTLPHeadersOptionReplacesEnvironment(t *testing.T) {
	c := newCaptureServer(t)
	t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer env-token,x-only-env=dropped")

	exportOneSpan(t, c, WithHeaders(map[string]string{"Authorization": "Bearer code-token"}))

	h := c.headerFor("/v1/traces")
	if h == nil {
		t.Fatal("no POST to /v1/traces was captured")
	}
	if got := h.Get("Authorization"); got != "Bearer code-token" {
		t.Errorf("Authorization = %q, want %q (option must beat env)", got, "Bearer code-token")
	}
	if got := h.Get("X-Only-Env"); got != "" {
		t.Errorf("X-Only-Env = %q, want empty: Go's WithHeaders replaces the env map "+
			"rather than merging (Node merges). If this now merges, upstream changed "+
			"and the docs must be updated.", got)
	}
}

func TestWithHeadersMerges(t *testing.T) {
	cfg, err := resolveConfig(
		WithServiceName("merge-test"),
		WithHeaders(map[string]string{"a": "1"}),
		WithHeaders(map[string]string{"b": "2"}),
	)
	if err != nil {
		t.Fatalf("resolveConfig: %v", err)
	}
	if cfg.Headers["a"] != "1" || cfg.Headers["b"] != "2" {
		t.Errorf("Headers = %v, want both a=1 and b=2", cfg.Headers)
	}
}
