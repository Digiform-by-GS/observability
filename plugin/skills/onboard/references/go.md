# Go onboarding reference

## Requirements

Go **1.25+** (the module is built with 1.26). On older toolchains the OTel
v1.44 dependencies fail to build — check `go version` before starting; a stale
system Go (apt-installed 1.22 is common) is the usual culprit even when a newer
one is installed elsewhere.

## Install

```bash
go get github.com/Digiform-by-GS/observability/packages/observability-go
```

## Wire it in — `main()`

Unlike Node there is no preload and no import-order hazard — Go instrumentation
is explicit wrapping. Initialize once in `main`. The library deliberately
installs **no signal handler** (it would race the server's own shutdown), so the
service owns the signal context:

```go
import (
    "context"
    "log"
    "os/signal"
    "syscall"
    "time"

    observability "github.com/Digiform-by-GS/observability/packages/observability-go"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    obs, err := observability.New(ctx, observability.WithServiceName("orders"))
    if err != nil {
        log.Fatal(err)
    }
    defer func() {
        // Bounded: a dead collector must not hold the process open on exit.
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        _ = obs.Shutdown(shutdownCtx)
    }()

    logger := obs.Logger()
    // ... build the server using logger; propagator and runtime metrics are already set up
}
```

If `OTEL_SERVICE_NAME` is set in the environment, `WithServiceName` can be
omitted — env vars fill every option (precedence: option > env > default).
`New` errors if the name is missing from both; that is deliberate.

`New()` also sets the **global text-map propagator**. This matters: Go's
default propagator is a silent no-op, and without this every service starts its
own fresh trace — spans look individually fine, nothing errors, and nothing
ever joins across services. If the user's code already calls
`otel.SetTextMapPropagator` somewhere, remove the duplicate.

## Router middleware — the one line that keeps the platform healthy

```go
// chi
r := chi.NewRouter()
r.Use(otelchi.Middleware("orders", otelchi.WithChiRoutes(r), otelchi.WithRequestMethodInSpanName(true)))
// import "github.com/riandyrn/otelchi"

// gin
r := gin.New()
r.Use(otelgin.Middleware("orders"))
// import "go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"

// echo
e := echo.New()
e.Use(otelecho.Middleware("orders"))
// import "go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho"
```

**Never bare `otelhttp.NewHandler` on a server.** Framework middleware names
spans after the route *template* (`GET /orders/{id}`) — bounded. Bare
`otelhttp` uses the concrete path (`GET /orders/42`) — one new metric series
set per distinct URL, which grows until the shared platform starts rejecting
metric writes for everyone. For frameworks not listed, find their OTel contrib
middleware; the acceptance criterion is route-template span names. Last resort:
`otelhttp` with an explicit span-name formatter that returns the route pattern.

**`WithRequestMethodInSpanName(true)` is not optional on chi.** Without it
otelchi names the span after the route alone — `/orders` — so `GET /orders`
and `POST /orders` become the *same* span name and share one set of
rate/error/latency series. You cannot tell a read from a write on the
dashboard, and there is no fallback: `http.method` is recorded as a span
attribute but is not one of the platform's span-metrics dimensions, so it
never reaches the metric labels. With the option the name is `GET /orders`,
matching OpenTelemetry's `{method} {route}` convention and the Node stack.

otelecho already does this by default (its formatter is `method + " " + path`),
so no extra option there. For any framework not listed, the acceptance
criterion is the same: a server span must read `GET /orders/{id}` — not a bare
path (`/orders/{id}`, methods collapsed) and not a concrete URL
(`GET /orders/42`, unbounded). Verify it with the verify skill before calling
the service onboarded.

**Outbound HTTP clients** are the other half of propagation — the wrapped
transport is what injects `traceparent`:

```go
client := &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport)}
// import "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
```

(`otelhttp` on the *client* side is correct and safe — the cardinality trap is
server-side span naming only.)

## Logging — the rule that has no compiler error

```go
logger.InfoContext(ctx, "order created", slog.String("order_id", id))  // correlated
logger.Info("order created", slog.String("order_id", id))              // NOT correlated
```

The second line compiles, runs, and raises no error — it just produces a log
that can never be joined to its trace. When migrating existing `slog` calls,
convert **every** call in request paths to the `...Context(ctx, ...)` form.

Two conventions:
- **Keys are snake_case** (`order_id`, not `orderID`) — matches how the
  platform spells resource attributes, so one query syntax works across fields.
- Constant messages, identifiers in fields — never `fmt.Sprintf` an id into
  the message.

Recommend adding `sloglint` to the client's linter so CI catches bare calls
(the compiler never will):

```yaml
# .golangci.yml
linters:
  enable:
    - sloglint
  settings:
    sloglint:
      context: all
```

## Dependency helpers (wire only what the service uses)

```go
// Redis — BEFORE any command is issued; adds per-command spans + pool gauges
import "github.com/Digiform-by-GS/observability/packages/observability-go/redisx"
client := redis.NewClient(&redis.Options{Addr: addr})
if err := redisx.Instrument(client); err != nil { /* fail startup */ }

// SQL — use the returned closer, not db.Close (it also unregisters pool stats)
import "github.com/Digiform-by-GS/observability/packages/observability-go/sqlx"
db, closeDB, err := sqlx.Open("pgx", dsn, "postgresql")
defer closeDB()
db.SetMaxOpenConns(10) // pool sizing stays the service's decision

// RabbitMQ — producer injects trace context; consumer starts a NEW root trace
// LINKED to the producer (deliberate: parent-child across queues produces
// meaningless hours-long traces; do not "fix" it)
import obsamqp "github.com/Digiform-by-GS/observability/packages/observability-go/amqp"
pub, _ := obsamqp.NewPublisher(ch)
pub.Publish(ctx, "", "orders", amqp091.Publishing{Body: body})

consumer, _ := obsamqp.NewConsumer()
consumer.Process(delivery, "orders", func(spanCtx context.Context, d amqp091.Delivery) error {
    logger.InfoContext(spanCtx, "order processed") // use spanCtx, not the outer ctx
    return nil // non-nil -> caller nacks -> DLQ
})
```

A consequence to warn RabbitMQ users about up front: because consumers link
rather than parent, **async hops do not appear as edges in the service graph**.
That is structural, not a bug in their integration; the producer/consumer
span-metrics still exist and are queryable.

## ctx discipline

The `context.Context` **is** the trace. Every function in a request path takes
`ctx` and passes it on — to the DB helper, the HTTP client, the logger, the
publisher. A `context.Background()` introduced mid-path severs everything below
it from the trace with no error anywhere. When editing user code, thread `ctx`;
when you see an existing `context.Background()` inside a request path, flag it.
