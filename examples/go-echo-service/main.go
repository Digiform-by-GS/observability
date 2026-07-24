// Command go-echo-service is the Echo counterpart of examples/go-service (which
// uses chi). It exists to show that the router choice is orthogonal to
// observability-go: the wiring is identical except for one middleware line, and
// the same route-template span-naming discipline applies.
//
// It deliberately stays minimal — HTTP only, no Redis/Postgres/RabbitMQ; those
// are demonstrated in go-service and are unrelated to the router.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	observability "github.com/digiform/observability-go"
	"github.com/labstack/echo/v4"
	"go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
)

const serviceName = "go-echo-service"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	// main owns signal handling, not the library.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	obs, err := observability.New(ctx, observability.WithServiceName(serviceName))
	if err != nil {
		return fmt.Errorf("init observability: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := obs.Shutdown(shutdownCtx); err != nil {
			fmt.Fprintf(os.Stderr, "observability shutdown: %v\n", err)
		}
	}()

	log := obs.Logger()

	e, err := newEcho(log)
	if err != nil {
		return err
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8091"
	}

	go func() {
		log.InfoContext(ctx, "listening", slog.String("port", port), slog.String("service", serviceName))
		if err := e.Start(":" + port); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.ErrorContext(ctx, "server error", slog.Any("error", err))
			stop()
		}
	}()

	<-ctx.Done()
	log.InfoContext(context.Background(), "shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return e.Shutdown(shutdownCtx)
}

func newEcho(log *slog.Logger) (*echo.Echo, error) {
	tracer := observability.Tracer(serviceName)
	meter := observability.Meter(serviceName)

	requests, err := meter.Int64Counter("app.requests",
		metric.WithDescription("Requests handled, by route."))
	if err != nil {
		return nil, fmt.Errorf("create app.requests counter: %w", err)
	}

	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	// The one line that differs from the chi example. otelecho names spans after
	// the route *template* (e.g. "GET /orders/:id"), NOT the concrete path
	// ("GET /orders/42"). Raw paths would make span_name unbounded and inflate
	// span-metrics cardinality in Mimir — the same reason go-service uses
	// otelchi rather than bare otelhttp.
	e.Use(otelecho.Middleware(serviceName))

	e.GET("/healthy", func(c echo.Context) error {
		requests.Add(c.Request().Context(), 1, metric.WithAttributes(attribute.String("route", "/healthy")))
		return c.JSON(http.StatusOK, map[string]string{"status": "ok", "service": serviceName})
	})

	// A path parameter, specifically to demonstrate route-template span naming:
	// hit /orders/1, /orders/2, /orders/... and they all share the span name
	// "GET /orders/:id" — one series, not one per id.
	e.GET("/orders/:id", func(c echo.Context) error {
		ctx := c.Request().Context()
		requests.Add(ctx, 1, metric.WithAttributes(attribute.String("route", "/orders/:id")))
		id := c.Param("id")
		log.InfoContext(ctx, "order fetched", slog.String("order_id", id))
		return c.JSON(http.StatusOK, map[string]string{"order_id": id, "status": "fetched"})
	})

	e.GET("/slow", func(c echo.Context) error {
		ctx := c.Request().Context()
		requests.Add(ctx, 1, metric.WithAttributes(attribute.String("route", "/slow")))
		delay := time.Duration(200+rand.Intn(300)) * time.Millisecond
		log.InfoContext(ctx, "sleeping", slog.Duration("delay", delay))
		time.Sleep(delay)
		return c.JSON(http.StatusOK, map[string]any{"status": "ok", "delayMs": delay.Milliseconds()})
	})

	e.GET("/error", func(c echo.Context) error {
		ctx := c.Request().Context()
		requests.Add(ctx, 1, metric.WithAttributes(attribute.String("route", "/error")))
		err := errors.New("intentional error for demo purposes")
		log.ErrorContext(ctx, "request failed", slog.Any("error", err))
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	})

	// /work proves outbound context propagation: the self-call must nest as a
	// child span, which only happens because New() set the global propagator and
	// the client transport is wrapped with otelhttp.
	e.GET("/work", func(c echo.Context) error {
		ctx := c.Request().Context()
		requests.Add(ctx, 1, metric.WithAttributes(attribute.String("route", "/work")))

		ctx, span := tracer.Start(ctx, "downstream-fetch")
		defer span.End()

		status, err := selfCall(ctx, c.Request().Host)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			log.ErrorContext(ctx, "downstream call failed", slog.Any("error", err))
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
		}
		span.SetAttributes(attribute.Int("http.response.status_code", status))
		log.InfoContext(ctx, "work complete", slog.Int("downstream_status", status))
		return c.JSON(http.StatusOK, map[string]any{"ok": true, "downstream_status": status})
	})

	return e, nil
}

func selfCall(ctx context.Context, host string) (int, error) {
	// otelhttp.NewTransport injects traceparent outbound.
	client := &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport),
		Timeout:   5 * time.Second,
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+host+"/healthy", nil)
	if err != nil {
		return 0, fmt.Errorf("build request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("call /healthy: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck // read-only request
	return resp.StatusCode, nil
}
