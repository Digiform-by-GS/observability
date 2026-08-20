// Package observability wires OpenTelemetry traces, metrics, and logs to an
// OTLP/HTTP collector with one call, mirroring the env-var contract of the
// @digiform-by-gs/observability Node package.
//
// Unlike the Node package there is no preload entry point, because Go
// instrumentation is explicit wrapping rather than module patching — the
// init-order problem simply does not exist here. Wrap your handlers and
// clients; nothing is monkey-patched behind your back.
package observability

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// Observability owns the SDK providers. Hold it in main and defer Shutdown.
type Observability struct {
	cfg    *Config
	tracer *sdktrace.TracerProvider
	meter  *sdkmetric.MeterProvider
	logs   *sdklog.LoggerProvider
	logger *slog.Logger
}

// New initialises the SDK and registers the global providers.
//
// It deliberately does NOT install signal handlers. main() owns
// signal.NotifyContext; a library grabbing SIGTERM fights http.Server.Shutdown
// and produces truncated shutdowns that are miserable to debug.
func New(ctx context.Context, opts ...Option) (*Observability, error) {
	cfg, err := resolveConfig(opts...)
	if err != nil {
		return nil, err
	}

	res, err := buildResource(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("observability: build resource: %w", err)
	}

	o := &Observability{cfg: cfg}

	// Trace exporter. WithEndpointURL takes the FULL signal URL. Using
	// WithEndpoint here instead would be a bug: the SDK also reads
	// OTEL_EXPORTER_OTLP_ENDPOINT itself and appends "/v1/traces", so a base
	// URL ends up requested as "/v1/traces/v1/traces" and every export 404s.
	//
	// Headers are appended only when set, so an unset option leaves the
	// exporter free to resolve OTEL_EXPORTER_OTLP_HEADERS from the environment.
	traceOpts := []otlptracehttp.Option{
		otlptracehttp.WithEndpointURL(cfg.Endpoint + "/v1/traces"),
	}
	if len(cfg.Headers) > 0 {
		traceOpts = append(traceOpts, otlptracehttp.WithHeaders(cfg.Headers))
	}
	traceExp, err := otlptracehttp.New(ctx, traceOpts...)
	if err != nil {
		return nil, fmt.Errorf("observability: trace exporter: %w", err)
	}
	o.tracer = sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExp),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(o.tracer)

	metricOpts := []otlpmetrichttp.Option{
		otlpmetrichttp.WithEndpointURL(cfg.Endpoint + "/v1/metrics"),
	}
	if len(cfg.Headers) > 0 {
		metricOpts = append(metricOpts, otlpmetrichttp.WithHeaders(cfg.Headers))
	}
	metricExp, err := otlpmetrichttp.New(ctx, metricOpts...)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("observability: metric exporter: %w", err), o.Shutdown(ctx))
	}
	o.meter = sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp,
			sdkmetric.WithInterval(cfg.MetricInterval))),
		sdkmetric.WithResource(res),
	)
	otel.SetMeterProvider(o.meter)

	logOpts := []otlploghttp.Option{
		otlploghttp.WithEndpointURL(cfg.Endpoint + "/v1/logs"),
	}
	if len(cfg.Headers) > 0 {
		logOpts = append(logOpts, otlploghttp.WithHeaders(cfg.Headers))
	}
	logExp, err := otlploghttp.New(ctx, logOpts...)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("observability: log exporter: %w", err), o.Shutdown(ctx))
	}
	o.logs = sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExp)),
		sdklog.WithResource(res),
	)
	global.SetLoggerProvider(o.logs)

	// THE critical line. Go's default propagator is a no-op, so without this
	// every service starts a fresh trace: spans look correct individually while
	// nothing ever joins up, and traceparent is neither sent nor read. It is the
	// most common Go OTel defect and the hardest to spot, because nothing errors.
	// (Node's NodeSDK does this for you, which is why it never comes up there.)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	o.logger = newLogger(cfg)

	// Without an error handler, export failures are silent — the collector goes
	// down and everything looks fine until you notice the dashboards are empty.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		// The OTel error handler carries no context, so this record is
		// necessarily uncorrelated — it reports SDK-level failures (a dead
		// collector), which belong to no single request anyway.
		o.logger.ErrorContext(context.Background(), "opentelemetry error",
			slog.Any("error", err))
	}))

	if !cfg.DisableRuntimeMetrics {
		if err := runtime.Start(runtime.WithMeterProvider(o.meter)); err != nil {
			o.logger.WarnContext(ctx, "runtime metrics disabled", slog.Any("error", err))
		}
	}

	return o, nil
}

// Logger returns the slog.Logger bridged to the OTel Logs API.
//
// Use the Context-suffixed methods — InfoContext, ErrorContext, ... — or the
// record carries no trace_id. Plain logger.Info compiles and runs and silently
// produces an uncorrelated log; the sloglint rule in .golangci.yml exists to
// catch that, and is not optional.
func (o *Observability) Logger() *slog.Logger { return o.logger }

// Config exposes the resolved configuration (useful for logging what was
// actually picked up at boot).
func (o *Observability) Config() Config { return *o.cfg }

// Shutdown flushes all three signals. Call it with a bounded context: a dead
// collector must not hold your process open.
func (o *Observability) Shutdown(ctx context.Context) error {
	var errs []error
	if o.logs != nil {
		if err := o.logs.Shutdown(ctx); err != nil {
			errs = append(errs, fmt.Errorf("logs: %w", err))
		}
	}
	if o.meter != nil {
		if err := o.meter.Shutdown(ctx); err != nil {
			errs = append(errs, fmt.Errorf("metrics: %w", err))
		}
	}
	if o.tracer != nil {
		if err := o.tracer.Shutdown(ctx); err != nil {
			errs = append(errs, fmt.Errorf("traces: %w", err))
		}
	}
	return errors.Join(errs...)
}
