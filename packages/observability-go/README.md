# observability-go

OpenTelemetry traces, metrics, and trace-correlated logs for Go services in one
call. The Go counterpart of [`@digiform-by-gs/observability`](../observability/),
sharing its environment-variable contract exactly — so a service author moving
between the Go, Node, and Next.js stacks configures all three identically.

## Compatibility

| Requirement | Version | Notes |
|---|---|---|
| Go toolchain | **1.25+** | A hard floor set by OTel v1.44. A 1.22/1.24 toolchain fails to build. |
| OpenTelemetry Go | `go.opentelemetry.io/otel` **v1.44.0** | Stable traces + metrics. The `sdk/log` and `api-logs` modules are `v0.20.0` (beta) and may change. |
| slog bridge | `otelslog` v0.19.0 | Correlated logging via `log/slog`. |
| Redis helper | `redisotel` / `go-redis` v9.21.0 | `redisx` subpackage. |
| SQL helper | `XSAM/otelsql` v0.43.0 | `sqlx` subpackage. |
| RabbitMQ helper | `amqp091-go` v1.13.0 | `amqp` subpackage. |
| Router middleware | `otelchi` v0.12.3, `contrib` v0.69.0 | The separate [`httpx`](httpx/) module — not a dependency of this one, so add it explicitly. |

### Installing this raises your OpenTelemetry version

Go resolves each dependency to the **maximum** version anyone in the graph requires, so
adding this module pulls `go.opentelemetry.io/otel` up to **v1.44.0** for your entire
build — including code that has nothing to do with observability. If you were on an
earlier version you will see an unrequested `go.mod` diff. That is expected, not a
mistake in your setup.

```bash
go list -m go.opentelemetry.io/otel   # what you actually resolved to
```

This matters most in repositories that already have OTel transitively — GCP and AWS
client libraries pull it in, which is common. It is also why the toolchain floor is not
negotiable: v1.44 needs Go 1.25, so this module raises both at once.

Your library version is **decoupled from the backend versions** — the module speaks OTLP
and nothing else, so you can upgrade it without touching Loki/Tempo/Mimir, and vice versa.

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

| Env var | Option | Example | Default |
|---|---|---|---|
| `OTEL_SERVICE_NAME` | `WithServiceName` | `orders` | — (**required**, `New` errors without it) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `WithEndpoint` | `http://localhost:4318` | `http://localhost:4318` |
| `OTEL_SERVICE_VERSION` | `WithServiceVersion` | `1.4.2` | `0.0.0` |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | `WithEnvironment` | `production` | `development` |
| `OTEL_RESOURCE_ATTRIBUTES` | `WithResourceAttributes` | `team=payments,region=eu-west-1` | none |
| `OTEL_LOG_LEVEL` | `WithLogLevel` | `info` | `info` |

Also: `WithMetricInterval` (default 60s), `WithoutRuntimeMetrics`,
`WithoutStdoutLogs`.

## Instrumenting HTTP

```go
r := chi.NewRouter()
r.Use(otelchi.Middleware("orders", otelchi.WithChiRoutes(r), otelchi.WithRequestMethodInSpanName(true)))          // server

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
