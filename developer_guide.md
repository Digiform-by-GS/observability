# Developer Guide — Instrumenting Your Service

How to add observability to a service, for both stacks this baseline supports.
One environment-variable contract, two libraries:

- **Node.js / TypeScript** → the `@digiform/observability` npm package
- **Go** → the `observability-go` module
- **Next.js (server-side)** → `@vercel/otel` inline (no wrapper — see the end)

You get distributed traces, metrics, and **trace-correlated logs** over OTLP,
with no knowledge of Loki/Tempo/Mimir in your code — you point at the OTel
Collector and it fans out.

> For the design rationale behind any choice here, see [`CLAUDE.md`](./CLAUDE.md).
> For running the stack and the incident playbook, see [`GUIDE.md`](./GUIDE.md).
> For Kubernetes, see [`deployment_guide.md`](./deployment_guide.md).

---

## Compatibility & versioning

Pin these. The app-side libraries speak **OTLP** to the Collector and nothing
else, so your library version is **decoupled from the backend versions** — you
can upgrade the wrapper without touching Loki/Tempo/Mimir, and vice versa. OTLP
is a stable, backward-compatible protocol.

### Node — `@digiform/observability@0.1.0`

| Requirement | Version | Notes |
|---|---|---|
| Node.js runtime | **`^18.19.0 \|\| >=20.6.0`** | Enforced in `engines`. Older 18.x / any 19.x is rejected. |
| Module system | **ESM only** | Your service needs `"type": "module"`. There is **no CommonJS build** — `--require` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. |
| TypeScript | 5.x | Optional; types ship with the package. |
| OpenTelemetry JS | `@opentelemetry/api` `^1.9.1`, SDK `^0.215.0` (experimental) + `^2.7.0` (stable) | The wrapper pins a **compatible set** — upgrade the wrapper, not the individual sub-packages. The `0.x` experimental packages can break between minors. |
| pino | `^10.3.1` | The logger you get from `getLogger()`. |

### Go — `github.com/digiform/observability-go`

| Requirement | Version | Notes |
|---|---|---|
| Go toolchain | **1.25+** (module built with 1.26.5) | Required by OTel v1.44. A 1.22/1.24 toolchain fails to build. |
| OpenTelemetry Go | `go.opentelemetry.io/otel` **v1.44.0** (stable traces/metrics) | The `sdk/log` + `api-logs` modules are `v0.20.0` (beta) and may change. |
| slog bridge | `otelslog` v0.19.0 | Correlated logging via `log/slog`. |
| Redis helper | `redisotel` / `go-redis` v9.21.0 | `redisx` subpackage. |
| SQL helper | `XSAM/otelsql` v0.43.0 | `sqlx` subpackage. |
| RabbitMQ | `amqp091-go` v1.13.0 | `amqp` subpackage. |
| HTTP (in examples) | `otelchi` v0.12.3, `otelhttp` v0.69.0 | Not module deps — your service picks its router wrapper. |

### The stack this targets

Collector `otel/opentelemetry-collector-contrib:0.154.0`; Grafana 13.0.1, Loki
3.7.1, Tempo 2.10.5, Mimir 3.0.6, Pyroscope 2.1.1. Apps only ever talk **OTLP to
the Collector on `:4318`** (HTTP) — you never address a backend directly.

### Upgrade policy

- **Production: pin exact versions** (`0.1.0`, not `^0.1.0`; a Go `go.sum` does
  this for you).
- Upgrade the **wrapper as a unit** — it exists precisely so you don't juggle
  ~10 individually-versioned OTel packages.
- Library upgrades and stack upgrades are **independent** thanks to OTLP. Bump
  one without the other.

---

## Node.js — `@digiform/observability`

### 1. Install

```bash
npm install @digiform/observability
```

Ensure your `package.json` has `"type": "module"`.

### 2. Add it to your code — the preload (recommended)

OpenTelemetry instruments libraries **as they are imported**. Anything imported
before the SDK starts is never traced. The `--import` preload guarantees the SDK
initializes first — nothing to call, nothing to order:

```bash
node --import @digiform/observability/preload src/index.js
```

Configure entirely through environment variables (see [the contract](#the-shared-environment-variable-contract)):

```bash
OTEL_SERVICE_NAME=orders \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_DEPLOYMENT_ENVIRONMENT=production \
node --import @digiform/observability/preload src/index.js
```

**Inline init (fallback)** — only when you need config that can't come from env
vars. It is fragile: `initObservability()` must run before *every* other import,
which a single hoisted `import` silently breaks.

```ts
import { initObservability } from '@digiform/observability';
const obs = initObservability({ serviceName: 'orders' });

// only now import instrumented libraries
import express from 'express';
```

### 3. API reference

#### `initObservability(options?): ObservabilityHandle`

Starts the SDK and registers global providers. Returns `{ shutdown(): Promise<void> }`.
Calling it twice logs a warning and no-ops. With the preload you never call this
yourself.

`ObservabilityOptions` (all optional; **option > env var > default**):

| Option | Type | Env var | Example | Default |
|---|---|---|---|---|
| `serviceName` | `string` | `OTEL_SERVICE_NAME` | `orders` | — (**required**) |
| `serviceVersion` | `string` | `OTEL_SERVICE_VERSION` | `1.4.2` | `npm_package_version` → `0.0.0` |
| `environment` | `string` | `OTEL_DEPLOYMENT_ENVIRONMENT` | `production` | `NODE_ENV` → `development` |
| `endpoint` | `string` | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | `http://localhost:4318` |
| `resourceAttributes` | `Record<string,string>` | `OTEL_RESOURCE_ATTRIBUTES` | `team=payments,region=eu-west-1` | `{}` |
| `metricExportIntervalMs` | `number` | — | `15000` | `60000` |
| `logLevel` | `pino.Level` | — | `'debug'` | `'info'` |
| `instrumentations` | `Instrumentation[]` | — | — | auto (replaces auto-instrumentations) |
| `additionalInstrumentations` | `Instrumentation[]` | — | — | `[]` (appends) |
| `disableAutoInstrumentations` | `boolean` | — | `true` | `false` |

#### `getLogger(): pino.Logger`

The pre-configured [pino](https://getpino.io) logger. Every record emitted inside
an active span is auto-stamped with `trace_id`/`span_id`. Throws if called before
init (can't happen with the preload).

```ts
import { getLogger } from '@digiform/observability';
const log = getLogger();

log.info({ orderId, amount }, 'order created');   // structured fields first
log.error({ err: { message: e.message, stack: e.stack } }, 'checkout failed');
```

- **Don't add `trace_id` yourself** — it's automatic.
- Extra fields become **structured metadata** in Loki, so `{service_name="orders"} | orderId="123"` works. They are *not* indexed labels, so high-cardinality ids are safe.

#### `getTracer(name, version?): Tracer` — custom spans

```ts
import { getTracer } from '@digiform/observability';
import { SpanStatusCode } from '@opentelemetry/api';
const tracer = getTracer('orders');

await tracer.startActiveSpan('reconcile-ledger', async (span) => {
  try {
    span.setAttribute('ledger.entries', entries.length);
    return await reconcile(entries);
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();          // always end the span
  }
});
```

#### `getMeter(name, version?): Meter` — custom metrics

```ts
import { getMeter } from '@digiform/observability';
const meter = getMeter('orders');

const created = meter.createCounter('app.orders.created', { description: 'Orders created.' });
created.add(1, { channel: 'web' });   // low-cardinality attributes only
```

Create instruments **once at module scope**, never per request.

### 4. Migrating an existing Node service

1. `npm install @digiform/observability`; set `"type": "module"` if not already.
2. Change your start command to `node --import @digiform/observability/preload …`.
3. Set `OTEL_SERVICE_NAME` + `OTEL_EXPORTER_OTLP_ENDPOINT`.
4. Replace ad-hoc `console.log`/existing logger with `getLogger()`.
5. Add `getTracer()` spans around meaningful business operations (I/O is already
   auto-traced).
6. [Verify](#verifying-your-integration).

The working reference is [`examples/nodejs-sample`](./examples/nodejs-sample/)
and the multi-service [`examples/microservices`](./examples/microservices/).

---

## Go — `observability-go`

### 1. Install

```bash
go get github.com/digiform/observability-go
```

Requires Go 1.25+.

### 2. Add it to your code

Unlike Node there is no preload and no init-order problem — Go instrumentation is
explicit wrapping. Initialize once in `main`, and **you own signal handling**
(the library deliberately installs none, or it would race `http.Server.Shutdown`):

```go
import (
    "context"
    "os/signal"
    "syscall"
    "time"
    observability "github.com/digiform/observability-go"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    obs, err := observability.New(ctx, observability.WithServiceName("orders"))
    if err != nil { log.Fatal(err) }
    defer func() {
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        _ = obs.Shutdown(shutdownCtx)   // bounded: a dead collector must not hold the process open
    }()

    logger := obs.Logger()
    // ... build your server using logger, observability.Tracer, observability.Meter
}
```

### 3. API reference

#### `New(ctx, ...Option) (*Observability, error)`

Initializes the SDK, registers global providers, **sets the global propagator**
(Go's default is a no-op — without this, traces never join across services), and
enables Go runtime metrics.

`Option` constructors (**option > env var > default**):

| Option | Env var | Example | Default |
|---|---|---|---|
| `WithServiceName(string)` | `OTEL_SERVICE_NAME` | `orders` | — (**required**, `New` errors without it) |
| `WithServiceVersion(string)` | `OTEL_SERVICE_VERSION` | `1.4.2` | `0.0.0` |
| `WithEnvironment(string)` | `OTEL_DEPLOYMENT_ENVIRONMENT` | `production` | `development` |
| `WithEndpoint(string)` | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | `http://localhost:4318` |
| `WithLogLevel(string)` | `OTEL_LOG_LEVEL` | `info` | `info` |
| `WithResourceAttributes(map[string]string)` | `OTEL_RESOURCE_ATTRIBUTES` | `team=payments,region=eu-west-1` | none |
| `WithMetricInterval(time.Duration)` | — | `15 * time.Second` | `60s` |
| `WithoutRuntimeMetrics()` | — | — | runtime metrics on |
| `WithoutStdoutLogs()` | — | — | stdout mirror on |

Methods: `obs.Logger() *slog.Logger`, `obs.Config() Config`, `obs.Shutdown(ctx) error`.
Package funcs: `observability.Tracer(name, ...) trace.Tracer`, `observability.Meter(name, ...) metric.Meter`.

#### Logging — the one rule

The logger is a standard `*slog.Logger`. **Always use the `Context` variants**, or
the record reaches Loki with no `trace_id`:

```go
logger.InfoContext(ctx, "order created", slog.String("order_id", id))   // correlated
logger.Info("order created", slog.String("order_id", id))               // NOT correlated
```

The second line **compiles, runs, and raises no error** — it just produces a log
that can never be joined to its trace. `.golangci.yml` enables `sloglint` with
`context: all` to catch exactly this; it is **not optional**, and CI enforces it.
Keys are **snake_case** (`order_id`) to match Loki's resource-attribute spelling.

#### Custom spans & metrics

```go
tracer := observability.Tracer("orders")
ctx, span := tracer.Start(ctx, "reconcile-ledger")
defer span.End()

meter := observability.Meter("orders")
created, _ := meter.Int64Counter("app.orders.created")
created.Add(ctx, 1, metric.WithAttributes(attribute.String("channel", "web")))
```

### 4. Instrumentation helpers

#### HTTP

Use your framework's **OTel middleware**, not bare `otelhttp`, on the server — it
names spans after the route *template* (`GET /orders/:id`), not the concrete path
(`GET /orders/42`), keeping `span_name` cardinality bounded. Whichever router you
use, that is the only line that changes; everything else in your service is
identical.

```go
// chi — see examples/go-service
r := chi.NewRouter()
r.Use(otelchi.Middleware("orders", otelchi.WithChiRoutes(r)))

// Echo — see examples/go-echo-service
e := echo.New()
e.Use(otelecho.Middleware("orders"))

// Gin
r := gin.New()
r.Use(otelgin.Middleware("orders"))

// Client — this wrapped transport is what injects traceparent outbound
client := &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport)}
```

Imports: `otelchi` (`github.com/riandyrn/otelchi`), `otelecho`
(`go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho`),
`otelgin` (`go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin`).
Verified: hitting `/orders/1..N` on the Echo example collapses to a single
`GET /orders/:id` span-metrics series, not N.

#### Redis — `observability-go/redisx`

```go
import "github.com/digiform/observability-go/redisx"

client := redis.NewClient(&redis.Options{Addr: "redis:6379"})
if err := redisx.Instrument(client); err != nil { /* ... */ }   // BEFORE any command
```

`Instrument` adds **both** tracing (a span per command) and metrics (pool gauges).
You need both: the collector's `redis` receiver reports server health, but only
client spans reveal *which endpoint* is hammering it.

#### SQL — `observability-go/sqlx`

```go
import "github.com/digiform/observability-go/sqlx"

db, closeDB, err := sqlx.Open("pgx", dsn, "postgresql")
if err != nil { /* ... */ }
defer closeDB()   // use this, not db.Close() — it also unregisters the pool-stats callback
db.SetMaxOpenConns(10)   // pool sizing stays yours
```

#### RabbitMQ / event-driven — `observability-go/amqp`

The important design point: **consumers start a new root trace linked to the
producer**, not a parent-child span. See [`CLAUDE.md`](./CLAUDE.md) for why.

```go
import obsamqp "github.com/digiform/observability-go/amqp"

// Producer — PRODUCER span, injects trace context into headers
pub, _ := obsamqp.NewPublisher(ch)   // ch is *amqp091.Channel (or the Channel interface)
pub.Publish(ctx, "", "orders", amqp091.Publishing{Body: body})

// Consumer — CONSUMER span, linked to the producer's trace
consumer, _ := obsamqp.NewConsumer()
consumer.Process(delivery, "orders", func(spanCtx context.Context, d amqp091.Delivery) error {
    logger.InfoContext(spanCtx, "order processed")
    return nil                                   // return an error -> caller nacks -> DLQ
})
```

Also exported: `HeaderCarrier` (the `TextMapCarrier` over AMQP headers),
`(*Consumer).RecordDLQ(ctx, queue, headers)` (records the origin trace id on a
dead-letter), and the `PublishedAtHeader` / `RetryCountHeader` constants.

### 5. Migrating an existing Go service

1. `go get github.com/digiform/observability-go`; ensure Go 1.25+.
2. Add `observability.New(ctx, …)` + `defer obs.Shutdown(...)` in `main`; own the
   signal context.
3. Wrap your router (`otelchi`/`otelgin`) and HTTP clients (`otelhttp.NewTransport`).
4. Replace your logger with `obs.Logger()` and switch every call to the
   `…Context(ctx, …)` form. Add `sloglint` to your lint config.
5. Instrument Redis/SQL/AMQP via the subpackages as needed.
6. [Verify](#verifying-your-integration).

Reference: [`examples/go-service`](./examples/go-service/) exercises HTTP, Redis,
Postgres, and RabbitMQ together.

---

## The shared environment-variable contract

The one thing that unifies every stack. Set these identically for Go, Node, and
Next.js — the mental model transfers.

**Only `OTEL_SERVICE_NAME` is mandatory.** Everything else has a safe default, so
a service will *start and emit telemetry* with just that one set. Several of the
optional ones are strongly recommended in any real deployment (marked below) —
"optional" means the code won't fail without it, not that you should skip it.

| Variable | Mandatory? | Example | Default if unset |
|---|---|---|---|
| `OTEL_SERVICE_NAME` | **Yes** | `orders` | none — **startup fails** |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No *(set in real deploys)* | `http://localhost:4318` | `http://localhost:4318` |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | No *(recommended)* | `production` | `development` (Go) / `NODE_ENV` → `development` (Node) |
| `OTEL_SERVICE_VERSION` | No | `1.4.2` | `0.0.0` (Go) / `npm_package_version` → `0.0.0` (Node) |
| `OTEL_RESOURCE_ATTRIBUTES` | No | `team=payments,region=eu-west-1` | empty |
| `OTEL_LOG_LEVEL` *(Go only)* | No | `info` | `info` |
| `PYROSCOPE_SERVER_ADDRESS` *(opt-in profiling)* | No | `http://localhost:4040` | unset → profiling off |

### What each one does, and what happens if you omit it

**`OTEL_SERVICE_NAME` — mandatory.**
The service's identity; every trace, metric, and log is tagged with it, and it
becomes an **indexed label** in Loki and the primary grouping in Tempo/Mimir.
*Omit it →* the library refuses to start (Node throws, Go's `New` returns an
error) — this is deliberate, because un-named telemetry is nearly useless.
*Gotcha:* keep it **stable and low-cardinality** — one value per logical service
(`orders`, `checkout-api`). Never put a pod name, instance id, or commit SHA
here; as an indexed label, high cardinality is expensive.

**`OTEL_EXPORTER_OTLP_ENDPOINT` — optional, but set it in any real deployment.**
The base URL of the OTel Collector your telemetry is sent to (OTLP/HTTP).
*Omit it →* defaults to `http://localhost:4318`, which is correct for local dev
but **silently wrong** in a container or Kubernetes, where the collector is a
different host — your telemetry goes nowhere and nothing errors. In K8s use
`http://otel-collector.observability.svc.cluster.local:4318`.

**`OTEL_DEPLOYMENT_ENVIRONMENT` — optional, strongly recommended.**
Stamps `deployment.environment` (`dev`/`staging`/`production`) on everything, so
you can filter one environment's data from another's.
*Omit it →* defaults to `development` (Go) or `NODE_ENV` (Node). *Gotcha:* it
**must match what the Collector stamps** (the collector also sets this via its
own `DEPLOYMENT_ENVIRONMENT`); if the app says `prod` and the collector says
`dev`, environment-filtered dashboards show only half the data.

**`OTEL_SERVICE_VERSION` — optional.**
Stamps `service.version` so you can tell *which build* emitted a given
trace/log/metric — useful for correlating an incident to a deploy or filtering a
canary. *Omit it →* defaults to `0.0.0` (Go) or your `package.json` version
(Node); everything still works. *Gotcha:* the Collector promotes resource
attributes to **metric labels**, so every distinct value creates a new set of
metric series. A **release/semver tag** (`1.4.2`) is low-cardinality and the
intended use. Do **not** put a per-commit git SHA here if you deploy on every
commit — that churns series against Mimir's cardinality limit. It never affects
tracing, logging, or cross-service correlation — those are unchanged whatever you
set.

**`OTEL_RESOURCE_ATTRIBUTES` — optional.**
Extra resource attributes as `key=value,key2=value2` (e.g. `team`, `region`),
merged into every signal. *Omit it →* none are added. *Gotcha:* same
metric-label promotion as above — keep the *values* low-cardinality.

**`OTEL_LOG_LEVEL` — optional, Go only.**
Minimum log level the Go logger emits (`debug`/`info`/`warn`/`error`).
*Omit it →* `info`. (The Node logger's level is set via the `logLevel` option,
not an env var.)

**`PYROSCOPE_SERVER_ADDRESS` — optional, opt-in.**
Enables continuous profiling by pointing the Pyroscope SDK at the server.
*Omit it →* profiling is simply off; traces/metrics/logs are unaffected. Set it
to `http://localhost:4040` (or the in-cluster Pyroscope service) to turn it on.

### Copy-paste starting point

```bash
# Mandatory
export OTEL_SERVICE_NAME=orders

# Optional but recommended in real deployments
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_DEPLOYMENT_ENVIRONMENT=production

# Optional
export OTEL_SERVICE_VERSION=1.4.2
export OTEL_RESOURCE_ATTRIBUTES=team=payments,region=eu-west-1
export OTEL_LOG_LEVEL=info                              # Go only
export PYROSCOPE_SERVER_ADDRESS=http://localhost:4040   # opt-in profiling
```

---

## Cross-cutting rules (both stacks)

- **Span names must be bounded.** Route templates, not raw paths; fixed operation
  names, not interpolated ids. Every distinct span name multiplies span-metrics
  series — this, not receivers, is what dominates cardinality growth.
- **Metric attribute values must be low-cardinality** (`channel`, `region` — never
  ids). Each combination is a time series, and Mimir rejects writes past its limits.
- **Log field spelling differs by stack**: Go emits `snake_case`, the Node examples
  emit `camelCase`. A query spanning both must handle both.
- **Always flush on shutdown** — Node's handle and Go's `Shutdown` both do this;
  call them (Go) / let the preload's handlers fire (Node).

---

## Verifying your integration

Generate a little traffic, then confirm the full round-trip (queries are in
[`GUIDE.md`](./GUIDE.md)):

1. **Trace** appears in Grafana → Explore → Tempo (`{ resource.service.name = "orders" }`).
2. **Logs** in Explore → Loki (`{service_name="orders"}`) carry a `trace_id`.
3. Click **View Trace** on a log → lands on the trace. Open a span → **Logs for
   this span** → returns that request's logs. Both directions = correlation works.
4. **Metrics** — your `app.*` counters and `http_*`/runtime metrics are in
   Explore → prometheus.

If logs have no `trace_id`: Node — you're not using the preload, or reverted the
main-thread bridge; Go — you used `logger.Info` instead of `InfoContext`. See the
troubleshooting tables in [`GUIDE.md`](./GUIDE.md).

---

## Next.js (server-side)

There is **no wrapper** for Next.js, and one wouldn't help — the package's
dependency tree (`sdk-node`, `pino`, the auto-instrumentations) is exactly what
Next's bundler and Edge runtime reject. Use `@vercel/otel` inline:

```ts
// instrumentation.ts at the project root (auto-detected, Next 15)
import { registerOTel } from '@vercel/otel';
export function register() {
  registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'web' });
}
```

It reads the **same env-var contract**, and server-side `fetch` auto-injects
`traceparent`, so Next → Go continuity works. Two limits: custom spans work only
in the Node runtime (`export const runtime = 'nodejs'`; middleware runs on Edge
and is effectively un-instrumentable), and `@vercel/otel` does traces + metrics
but **not logs** — correlated Next server logs are optional, later work.
