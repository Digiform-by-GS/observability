# go-echo-service — Echo example

The [Echo](https://echo.labstack.com/) counterpart of
[`examples/go-service`](../go-service/) (which uses chi). It exists to show that
**the HTTP router is orthogonal to `observability-go`**: the wiring is identical
except for one middleware line.

It stays deliberately minimal — HTTP only, no Redis/Postgres/RabbitMQ. Those are
demonstrated in `go-service` and have nothing to do with the router.

## Run

Requires the stack up (`docker compose up -d`). Runs on the host against the
published collector port:

```bash
OTEL_SERVICE_NAME=go-echo-service OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  PORT=8091 go run .
```

## The one line that differs from the chi example

```go
e.Use(otelecho.Middleware(serviceName))   // vs. otelchi.Middleware(...) in go-service
```

Everything else — `observability.New`, `obs.Logger()`, `observability.Tracer`,
`InfoContext` logging, `otelhttp.NewTransport` on the client — is the same.

## Endpoints

| Route | Purpose |
|---|---|
| `/healthy` | 200 |
| `/orders/:id` | **path parameter** — the route-template demo |
| `/slow` | sleeps 200–500ms, logs with context |
| `/error` | 500 + error log |
| `/work` | custom span + instrumented self-call (propagation) |

## Why the `:id` route matters

Framework middleware (otelecho, otelchi) names spans after the route *template*,
not the concrete path. Hit `/orders/1`, `/orders/2`, … `/orders/99` and they all
share **one** span name, `GET /orders/:id` — verified against the running stack:

```
sum by (span_name) (traces_spanmetrics_calls_total{service="go-echo-service"})
   13  GET /orders/:id      ← 13 distinct ids, ONE series
    8  GET /healthy
    6  GET /error
    1  GET /work
    1  downstream-fetch
    1  HTTP GET
```

Bare `otelhttp` would instead produce `GET /orders/1`, `GET /orders/2`, … — one
`span_name` per id, which multiplies span-metrics series until Mimir rejects the
writes. That is the whole reason to use the framework wrapper. (NB: Tempo's
span-metrics label the service `service`, not `service_name`.)

Logs are trace-correlated exactly as in `go-service` — same library, same
`InfoContext(ctx, …)` discipline.
