// Command go-service is the Go counterpart of examples/nodejs-sample: an HTTP
// service wired to observability-go, emitting traces, metrics, and
// trace-correlated logs over OTLP.
//
// It exists to prove the Phase 1 acceptance test end to end:
//
//	hit an endpoint -> trace in Tempo -> "Logs for this span" returns that
//	request's logs -> the log's trace_id links back to the trace
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	observability "github.com/Digiform-by-GS/observability/packages/observability-go"
	"github.com/Digiform-by-GS/observability/packages/observability-go/httpx/chix"
	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
)

const serviceName = "go-service"

func main() {
	if err := run(); err != nil {
		// The logger may not exist yet, so fall back to stderr.
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	// main owns signal handling, not the observability library — otherwise the
	// library's handler races http.Server.Shutdown.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	obs, err := observability.New(ctx, observability.WithServiceName(serviceName))
	if err != nil {
		return fmt.Errorf("init observability: %w", err)
	}
	defer func() {
		// Bounded: a dead collector must not hold the process open.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := obs.Shutdown(shutdownCtx); err != nil {
			fmt.Fprintf(os.Stderr, "observability shutdown: %v\n", err)
		}
	}()

	log := obs.Logger()

	// Opened after observability so the instrumentation hooks are registered
	// before the first command or query is issued.
	d, err := openDeps(ctx)
	if err != nil {
		return fmt.Errorf("open dependencies: %w", err)
	}
	defer func() {
		if err := d.Close(); err != nil {
			log.ErrorContext(context.Background(), "closing dependencies", slog.Any("error", err))
		}
	}()

	mq, err := openMessaging(log)
	if err != nil {
		return fmt.Errorf("open messaging: %w", err)
	}
	defer func() {
		if err := mq.Close(); err != nil {
			log.ErrorContext(context.Background(), "closing messaging", slog.Any("error", err))
		}
	}()

	// Run the consumer loop alongside the HTTP server. It stops when ctx is
	// cancelled by the signal handler.
	if mq != nil {
		go func() {
			if err := mq.consume(ctx); err != nil {
				log.ErrorContext(ctx, "consumer loop stopped", slog.Any("error", err))
			}
		}()
	}

	srv, err := newServer(log, d, mq)
	if err != nil {
		return err
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8090"
	}
	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.InfoContext(ctx, "listening",
			slog.String("port", port),
			slog.String("service", serviceName))
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return fmt.Errorf("http server: %w", err)
	case <-ctx.Done():
		log.InfoContext(context.Background(), "shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}

func newServer(log *slog.Logger, d *deps, m *messaging) (http.Handler, error) {
	tracer := observability.Tracer(serviceName)
	meter := observability.Meter(serviceName)

	// Instruments are created once, never per request. Attribute values stay
	// low-cardinality — every distinct combination is its own time series.
	requests, err := meter.Int64Counter("app.requests",
		metric.WithDescription("Requests handled, by route."))
	if err != nil {
		return nil, fmt.Errorf("create app.requests counter: %w", err)
	}
	work, err := meter.Int64Counter("app.work.invocations",
		metric.WithDescription("Times /work was called."))
	if err != nil {
		return nil, fmt.Errorf("create app.work counter: %w", err)
	}

	r := chi.NewRouter()

	// chix, not bare otelhttp: chi exposes the route *pattern*, so spans are
	// named "GET /orders/{id}" rather than "GET /orders/8fe2...". Raw paths would
	// make span_name unbounded and blow up span-metrics cardinality in Mimir.
	// The router is passed in because otelchi needs it to resolve templates.
	r.Use(chix.Middleware(serviceName, r))

	r.Get("/healthy", func(w http.ResponseWriter, req *http.Request) {
		requests.Add(req.Context(), 1, metric.WithAttributes(attribute.String("route", "/healthy")))
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": serviceName})
	})

	r.Get("/slow", func(w http.ResponseWriter, req *http.Request) {
		ctx := req.Context()
		requests.Add(ctx, 1, metric.WithAttributes(attribute.String("route", "/slow")))

		delay := time.Duration(200+rand.Intn(300)) * time.Millisecond
		// InfoContext, not Info: the ctx is what carries the active span, and
		// without it this log reaches Loki with no trace_id.
		log.InfoContext(ctx, "sleeping", slog.Duration("delay", delay))
		time.Sleep(delay)

		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "delayMs": delay.Milliseconds()})
	})

	r.Get("/error", func(w http.ResponseWriter, req *http.Request) {
		ctx := req.Context()
		requests.Add(ctx, 1, metric.WithAttributes(attribute.String("route", "/error")))

		err := errors.New("intentional error for demo purposes")
		log.ErrorContext(ctx, "request failed", slog.Any("error", err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	})

	// /work exercises the part most likely to be broken: outbound context
	// propagation. The self-call must appear as a child span, which only happens
	// if the global propagator is set and the client transport is wrapped.
	r.Get("/work", func(w http.ResponseWriter, req *http.Request) {
		ctx := req.Context()
		requests.Add(ctx, 1, metric.WithAttributes(attribute.String("route", "/work")))
		work.Add(ctx, 1)

		ctx, span := tracer.Start(ctx, "downstream-fetch")
		defer span.End()

		status, err := selfCall(ctx, req)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			log.ErrorContext(ctx, "downstream call failed", slog.Any("error", err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		span.SetAttributes(attribute.Int("http.response.status_code", status))
		log.InfoContext(ctx, "work complete", slog.Int("downstream_status", status))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "downstreamStatus": status})
	})

	mountDataRoutes(r, d, m, log, requests)

	return r, nil
}

// selfCall issues an instrumented request back to this service, mirroring the
// Node sample's /work endpoint.
func selfCall(ctx context.Context, req *http.Request) (int, error) {
	// otelhttp.NewTransport is what injects traceparent on the way out. A bare
	// http.Client would produce a disconnected trace on the receiving end.
	client := &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport),
		Timeout:   5 * time.Second,
	}

	url := "http://" + req.Host + "/healthy"
	outbound, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, fmt.Errorf("build request: %w", err)
	}

	resp, err := client.Do(outbound)
	if err != nil {
		return 0, fmt.Errorf("call %s: %w", url, err)
	}
	defer resp.Body.Close() //nolint:errcheck // response body close on a read-only request

	return resp.StatusCode, nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
