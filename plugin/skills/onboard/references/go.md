# Go onboarding reference

## Requirements

Go **1.25+** (the module is built with 1.26). On older toolchains the OTel
v1.44 dependencies fail to build — check `go version` before starting; a stale
system Go (apt-installed 1.22 is common) is the usual culprit even when a newer
one is installed elsewhere.

## Install

```bash
go get github.com/Digiform-by-GS/observability/packages/observability-go@v0.1.1
go get github.com/Digiform-by-GS/observability/packages/observability-go/httpx@v0.1.0   # if it serves HTTP
go mod tidy
```

Versions from [compat.json](compat.json) — do not substitute your own. `httpx`
is a **separate module**, so `go get` on the parent does not bring it.

**Expect an unrequested `go.mod` diff.** Go resolves every dependency to the
maximum version anyone in the graph requires, so adding this module pulls
`go.opentelemetry.io/otel` up to v1.44.0 across the client's entire build —
including code unrelated to observability. That is correct, not a mistake, but
say so in the PR body rather than letting a reviewer discover it. Check with
`go list -m go.opentelemetry.io/otel`.

**Use this module. Do not hand-roll an OpenTelemetry setup.** If a repository
already has otel packages in its dependency tree — GCP client libraries pull
them in transitively, which is common — it is tempting to write your own
exporter and provider wiring from what is already there. Do not. That path
skips the global propagator (Go's default is a silent no-op, so nothing joins
across services), the slog bridge that correlates logs, the bounded shutdown,
and the error handler that makes a dead collector visible. Add the module.

`go mod tidy` is not optional: Go writes dependency checksums into go.sum and
refuses to build without them, so a go.mod edit alone yields a patch that
cannot compile.

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

Use the `httpx` module. It is a separate module from `observability-go`, so add
it explicitly (version in [compat.json](compat.json)):

```bash
go get github.com/Digiform-by-GS/observability/packages/observability-go/httpx
```

```go
// chi — pass the router itself; otelchi needs it to resolve route templates
r := chi.NewRouter()
r.Use(chix.Middleware("orders", r))

// gin
r := gin.New()
r.Use(ginx.Middleware("orders"))

// echo
e := echo.New()
e.Use(echox.Middleware("orders"))

// gorilla/mux
r := mux.NewRouter()
r.Use(muxx.Middleware("orders"))
```

Import paths are `.../observability-go/httpx/chix`, `/ginx`, `/echox`, `/muxx`.
Each takes its framework's option type as a variadic tail, so filters and
tracer providers still get through:

```go
r.Use(muxx.Middleware("orders", otelmux.WithFilter(skipWebsockets)))
```

**Why not wire the upstream middleware directly.** Span names become metric
label values in Tempo's span-metrics generator, and each distinct name
multiplies by the latency histogram's bucket count. A naming mistake therefore
does not degrade the offending service — it fills Mimir, and Mimir then rejects
metric writes for **every tenant on the platform**. The correct incantation
differs per router (otelchi needs two options, otelmux needs a hand-written
formatter and has no option at all, otelgin and otelecho are already right), and
`httpx` encodes all four with tests. Getting it right by hand is possible;
getting it right every time, in every repo, is what fails.

**The acceptance criterion, for any framework:** a server span must read
`GET /orders/{id}`. Two ways to fail it:
- **Unbounded** — `GET /orders/42`. The concrete path reaches the name, so every
  distinct URL mints a new series set. This is what bare `otelhttp.NewHandler`
  does on a server.
- **Collapsed** — `/orders`, method dropped. `GET` and `POST` then share one set
  of rate/error/latency series and a read is indistinguishable from a write.
  `http.method` is a span attribute but **not** a span-metrics dimension here,
  so the distinction cannot be recovered afterwards.

**For a framework `httpx` does not cover**, find its contrib middleware and check
that criterion. Last resort is `otelhttp` with an explicit span-name formatter
returning the route pattern — never bare `otelhttp.NewHandler(router, "svc")`,
which is the worst outcome available: every request in the service collapses to
the single span name "svc", and the dashboards show one green line that means
nothing. Verify with the verify skill before calling the service onboarded.

## Three things the middleware will not do for you

These were all found in one real Go service. Each is silent — nothing errors,
and the dashboards look plausible.

**WebSocket routes produce hours-long spans.** The middleware wraps the upgrade
handler, so the span stays open for the life of the connection. One chat session
becomes a multi-hour server span that lands in the same latency histogram as
your HTTP routes and destroys p95. Exclude them:

```go
r.Use(muxx.Middleware("orders", otelmux.WithFilter(func(req *http.Request) bool {
    return !websocket.IsWebSocketUpgrade(req)  // false = not traced
})))
```

**Scheduled jobs are invisible.** A `gocron`/`cron`/ticker job has no inbound
request, so no middleware runs, so there is no span and no context — and
`InfoContext(ctx, ...)` on a background context produces an uncorrelated log.
The job simply does not exist in the platform. Start a root span per run:

```go
tracer := observability.Tracer("jobs")
scheduler.NewJob(..., gocron.NewTask(func() {
    ctx, span := tracer.Start(context.Background(), "reconcile-invoices")
    defer span.End()
    if err := reconcile(ctx); err != nil {   // pass ctx down, always
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
    }
}))
```

Name the span after the job, not the run — a timestamp or run id in the span
name is the unbounded-cardinality bug in a new disguise.

**Outbound clients that build their own transport propagate nothing.** Any SDK
constructing its own `http.Client` — `gocloak`, `resty`, most vendor SDKs —
sends no `traceparent`, so the trace ends at that hop and the downstream service
starts a fresh unrelated trace. Nothing errors; the chain is just quietly
severed. Wrap the transport wherever the client is built:

```go
// resty
client := resty.New()
client.SetTransport(otelhttp.NewTransport(http.DefaultTransport))

// gocloak and similar: reach for the SetRestyClient/WithClient escape hatch
gc := gocloak.NewClient(url)
gc.RestyClient().SetTransport(otelhttp.NewTransport(http.DefaultTransport))
```

When onboarding, grep for `http.Client{`, `resty.New`, and SDK constructors, and
report any you could not wrap — an unwrapped client is a known gap, not a
finished onboarding.

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
