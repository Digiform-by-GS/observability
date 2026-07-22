# observability-go

OpenTelemetry traces, metrics, and trace-correlated logs for Go services in one
call. The Go counterpart of [`@digiform/observability`](../observability/),
sharing its environment-variable contract exactly — so a service author moving
between the Go, Node, and Next.js stacks configures all three identically.

Requires **Go 1.25+** (upstream OTel v1.44 sets that floor).

## Quick start

```go
func main() {
    // main owns signal handling — the library deliberately does not install
    // handlers, or it would race http.Server.Shutdown.
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    obs, err := observability.New(ctx, observability.WithServiceName("orders"))
    if err != nil {
        log.Fatal(err)
    }
    defer func() {
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        _ = obs.Shutdown(shutdownCtx)
    }()

    logger := obs.Logger()
    // ...
}
```

```bash
OTEL_SERVICE_NAME=orders OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 ./orders
```

## Logging — the one rule

**Always use the `Context` variants.** `logger.InfoContext(ctx, ...)` carries the
active span, so the record reaches Loki with a `trace_id` you can pivot on.

```go
logger.InfoContext(ctx, "order created", slog.String("order_id", id))  // correlated
logger.Info("order created", slog.String("order_id", id))              // NOT correlated
```

The second line **compiles, runs, and raises no error** — it just produces a log
that can never be joined to its trace. That is why
[`.golangci.yml`](../../.golangci.yml) enables `sloglint` with `context: all`,
and why it is not optional. Verified: injecting a bare `slog.Info` builds
cleanly and is caught only by the linter.

Keys are snake_case (`order_id`, not `orderId`) to match the spelling of
resource attributes in Loki (`service_name`, `deployment_environment`).

Records also mirror to stdout as JSON, so logs stay visible when the collector
is unreachable — the moment you most need them.

## Configuration

Precedence is **option > environment variable > default**.

| Env var | Option | Default |
|---|---|---|
| `OTEL_SERVICE_NAME` | `WithServiceName` | — (**required**, `New` errors without it) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `WithEndpoint` | `http://localhost:4318` |
| `OTEL_SERVICE_VERSION` | `WithServiceVersion` | `0.0.0` |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | `WithEnvironment` | `development` |
| `OTEL_RESOURCE_ATTRIBUTES` | `WithResourceAttributes` | none |
| `OTEL_LOG_LEVEL` | `WithLogLevel` | `info` |

Also: `WithMetricInterval` (default 60s), `WithoutRuntimeMetrics`,
`WithoutStdoutLogs`.

## Instrumenting HTTP

```go
r := chi.NewRouter()
r.Use(otelchi.Middleware("orders", otelchi.WithChiRoutes(r)))          // server

client := &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport)} // client
```

Use the **framework** wrapper (`otelchi`, `otelgin`), not bare `otelhttp`, on the
server side. Framework wrappers name spans after the route *template*
(`GET /orders/{id}`); raw `otelhttp` uses the concrete path
(`GET /orders/8fe2c4...`), which makes `span_name` unbounded and inflates
span-metrics cardinality in Mimir until writes start getting rejected.

`otelhttp.NewTransport` on the client is what injects `traceparent` outbound. A
bare `http.Client` produces a disconnected trace at the far end.

## What `New` does that is easy to miss

1. **Sets the global propagator** to TraceContext + Baggage. Go's default is a
   **no-op**, so without this every service starts a fresh trace — spans look
   individually correct while nothing ever joins up, and nothing errors. It is
   the most common Go OTel defect. `TestNewSetsTraceContextPropagator` guards it.
2. **Builds full signal URLs** (`…/v1/traces`) and passes them explicitly. The
   SDK also reads `OTEL_EXPORTER_OTLP_ENDPOINT` and appends the suffix itself,
   so passing a base URL yields `/v1/traces/v1/traces` and every export 404s.
3. **Installs an error handler**, or export failures are silent and you discover
   the collector died by noticing empty dashboards.
4. **Enables Go runtime metrics** (GC, goroutines, heap) — the best early
   predictor of a p99 about to get worse.

## Differences from the Node package, and why

| | Node | Go |
|---|---|---|
| Init | `--import` preload | explicit `New()` |
| Errors | throws | returns `error` |
| Signals | library installs handlers | **caller owns them** |
| Log correlation | main-thread bridge captures ambient context | explicit `ctx` argument |

There is **no preload entry point** and no init-order problem: Go
instrumentation is explicit wrapping, not module patching. The `globalThis`
dual-bundle workaround in the Node package's `accessors.ts` has no analogue here
and should not be ported.

## Testing

```bash
go test ./...
golangci-lint run --config ../../.golangci.yml ./...
```
