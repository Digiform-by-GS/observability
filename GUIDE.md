# Observability Guide

How to instrument a service with `@digiform/observability`, and how to run and debug the
backing stack. Written for two audiences:

- **[Developer Guide](#developer-guide)** — you own a Node service and want traces, metrics, and
  trace-correlated logs without wiring ~10 OpenTelemetry packages yourself.
- **[Operations Guide](#operations-guide)** — you run the stack, configure services per
  environment, and drive incidents.

Start with the Quick Start; it works end-to-end in about five minutes.

---

## Quick Start

### 1. Bring up the backend stack

```bash
git clone <this-repo> && cd observability
docker compose up -d
```

Wait ~60s, then confirm the backends are ready. **Do not use `docker compose ps` for this** — the
Loki/Tempo/Mimir images are distroless and carry no healthcheck, so they never report "healthy":

```bash
for p in 3100 3200 9009; do curl -s -o /dev/null -w "$p: %{http_code}\n" http://localhost:$p/ready; done
# expect: 3100: 200   3200: 200   9009: 200   (503 = still starting, wait and retry)
```

Grafana is at <http://localhost:3000> (anonymous admin, no login). Datasources and dashboards are
pre-provisioned.

### 2. Add the library to your service

```bash
npm install @digiform/observability
```

**Requires Node 18.19+ or 20.6+, and your service must be ESM** (`"type": "module"`).
This package is ESM-only — there is no CommonJS build.

### 3. Start your service with the preload

```bash
OTEL_SERVICE_NAME=my-service \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
node --import @digiform/observability/preload src/index.js
```

That is the whole integration. HTTP servers/clients, Express, and most common libraries are
auto-instrumented — you get traces and metrics with no code change.

### 4. Log with trace correlation

```js
import { getLogger } from '@digiform/observability';

const log = getLogger();
log.info({ orderId: '123' }, 'order created');
```

Every record emitted inside a request automatically carries `trace_id` and `span_id`.

### 5. See it in Grafana

Send some traffic, then:

- **Explore → Tempo** → `{ resource.service.name = "my-service" }` — your traces
- **Explore → Loki** → `{service_name="my-service"}` — your logs; click **View Trace** on any line
- **Dashboards → Observability → Observability Overview** — request rate, error rate, p95

If nothing appears, jump to [Troubleshooting](#troubleshooting).

---

## Developer Guide

### Why the preload, and why it matters

OpenTelemetry patches libraries (`http`, `express`, `pg`, …) **as they are imported**. Anything
imported before the SDK starts is never instrumented. The `--import` preload guarantees the SDK
initialises first:

```bash
node --import @digiform/observability/preload src/index.js
```

There is an inline alternative, but it is fragile — `initObservability()` must run before *every*
other import, which a single hoisted `import` at the top of your entry file will silently break:

```js
import { initObservability } from '@digiform/observability';
const obs = initObservability({ serviceName: 'my-service' });
// only now import express, pg, etc.
```

**Use the preload.** Reach for inline init only when you need programmatic config that can't come
from env vars.

### Configuration

Config resolves as **option > environment variable > default**. With the preload, env vars are the
only input.

| Env var | Option | Default | Notes |
|---|---|---|---|
| `OTEL_SERVICE_NAME` | `serviceName` | — | **Required.** Init throws without it. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `endpoint` | `http://localhost:4318` | Collector base URL, OTLP/HTTP. |
| `OTEL_SERVICE_VERSION` | `serviceVersion` | `npm_package_version` → `0.0.0` | |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | `environment` | `NODE_ENV` → `development` | |
| `OTEL_RESOURCE_ATTRIBUTES` | `resourceAttributes` | `{}` | `key=value,key2=value2`. Merged. |
| `OTEL_NODE_DISABLED_INSTRUMENTATIONS` | — | — | Honoured by the auto-instrumentations. |

Code-only options: `instrumentations` (replaces auto-instrumentations entirely),
`additionalInstrumentations` (appends), `disableAutoInstrumentations`, `metricExportIntervalMs`
(default `60000`), `logLevel` (default `'info'`).

### Logging

```js
import { getLogger } from '@digiform/observability';
const log = getLogger();

log.info({ orderId, amount }, 'order created');   // structured fields first, message second
log.warn({ retries }, 'retrying downstream call');
log.error({ err: { message: err.message, stack: err.stack } }, 'checkout failed');
```

It is a standard [pino](https://getpino.io) logger. Two things to know:

- **Trace context is attached automatically.** Do not add `trace_id` yourself.
- **Fields become queryable.** Extra fields land in Loki as structured metadata, so
  `{service_name="my-service"} | orderId="123"` works. They are *not* indexed labels, so
  high-cardinality fields like ids are safe.

`getLogger()` throws if called before init — with the preload that can't happen, but it will if
you call it at module scope in a file imported by an inline-init entry point.

### Custom spans

Auto-instrumentation covers I/O. Add spans for meaningful business operations:

```js
import { getTracer } from '@digiform/observability';
const tracer = getTracer('my-service');

const result = await tracer.startActiveSpan('reconcile-ledger', async (span) => {
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

`startActiveSpan` makes the span current, so nested calls and log lines inside the callback attach
to it automatically.

### Custom metrics

```js
import { getMeter } from '@digiform/observability';
const meter = getMeter('my-service');

const ordersCreated = meter.createCounter('app.orders.created', {
  description: 'Orders successfully created.',
});
ordersCreated.add(1, { channel: 'web' });
```

Create instruments **once at module scope**, not per request. Keep attribute values low-cardinality
(`channel`, `region` — never user ids or order ids); every distinct combination is a time series.

### Cross-service tracing

Nothing to configure. Trace context propagates over HTTP automatically via the W3C `traceparent`
header, in both directions, as long as both services use this library and you use a standard HTTP
client (`fetch`, `axios`, `http`). A request through three services produces **one trace**.

### Shutdown

`SIGTERM`/`SIGINT` handlers that flush pending telemetry are installed for you. If you manage your
own shutdown, close your HTTP server first so in-flight requests finish:

```js
const stop = () => server.close(() => process.exit(0));
process.once('SIGTERM', stop);
```

### Local development loop

```bash
docker compose up -d                      # stack
OTEL_SERVICE_NAME=my-service node --import @digiform/observability/preload src/index.js
```

Logs also print to stdout, so you keep normal local visibility while telemetry ships to the stack.

Two working references live in this repo:

- [`examples/nodejs-sample`](./examples/nodejs-sample/) — single service, four endpoints
- [`examples/microservices`](./examples/microservices/) — three chained services + fault injection

---

## Operations Guide

### Architecture

```
Your services ──OTLP/HTTP :4318──► OTel Collector ─┬─► Loki   :3100   logs
                                                   ├─► Tempo          traces
                                                   └─► Mimir  :9009   metrics
                                    Tempo generator ──► Mimir  (span-metrics + service graph)
                                    Grafana :3000 ────► all three
```

Applications only ever talk to the Collector. Swapping a backend is a Collector config change, not
an application change.

### Per-environment configuration

The only thing that changes between environments is env vars:

```bash
OTEL_SERVICE_NAME=orders                        # required, unique per service
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_DEPLOYMENT_ENVIRONMENT=production
OTEL_SERVICE_VERSION=1.4.2                      # wire your build/release tag here
OTEL_RESOURCE_ATTRIBUTES=team=payments,region=eu-west-1
```

`OTEL_SERVICE_NAME` and `OTEL_DEPLOYMENT_ENVIRONMENT` become indexed Loki labels — keep them stable
and low-cardinality. Never put a pod name, build id, or commit sha in `OTEL_SERVICE_NAME`.

### Ports

| Port | Service | Purpose |
|---|---|---|
| 3000 | Grafana | UI |
| 3100 | Loki | HTTP API + OTLP push |
| 3200 | Tempo | HTTP API (Grafana datasource) |
| 4317 / 4318 | OTel Collector | OTLP gRPC / HTTP — **what apps point at** |
| 8888 | OTel Collector | self-metrics |
| 9009 | Mimir | Prometheus-compatible API |

### Health checks

The Loki/Tempo/Mimir images are distroless — no shell, no `wget`/`curl` — so container-level
healthchecks are deliberately absent and `docker compose ps` will never say "healthy". Probe from
outside:

```bash
curl -s http://localhost:3100/ready    # loki  → "ready"
curl -s http://localhost:3200/ready    # tempo → "ready"
curl -s http://localhost:9009/ready    # mimir → "ready"
curl -s http://localhost:3000/api/health

# Is the Collector accepting data?
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4318/v1/traces \
  -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'   # expect 200
```

A `503` on `/ready` shortly after startup is normal — Loki and Tempo hold ready for ~15s after
their ingester comes up.

### Routine operations

```bash
docker compose up -d                      # start / apply config changes
docker compose logs -f otel-collector     # first place to look when signals go missing
docker compose restart otel-collector     # configs are bind-mounted; no rebuild needed
docker compose down                       # stop, keep data
docker compose down -v                    # stop and DELETE all telemetry data
```

After any stack restart, Tempo's metrics generator needs **~30s of fresh traffic** before
span-metrics and service-graph series reappear. Empty RED panels immediately after a restart are
expected, not a fault.

### Capacity and retention

Defaults are tuned for local development, not production:

- Loki retention is **168h (7 days)**; storage is the local filesystem.
- Mimir/Tempo use local filesystem storage with a replication factor of 1 — **no redundancy**.
- The Collector's `memory_limiter` is capped at **512 MiB**.
- Grafana runs with **anonymous admin and no auth**, and there is **no TLS** between components.

Before production: move to object storage, set real retention, enable auth/TLS, and consider tail
sampling. See [Out of Scope](./CLAUDE.md#out-of-scope-v1).

---

## Incident Playbook — "something broke, what's impacted?"

Work top-down. The goal is to separate the **cause** from its **victims**.

### 1. Establish blast radius

**Dashboards → Observability → Blast Radius.**

*Failing dependencies* lists broken `caller → callee` edges. The **deepest failing callee is the
root cause**; everything calling into it is collateral damage. A chain like:

```
user         → checkout-api   failing
checkout-api → orders         failing
orders       → payments       failing
```

means `payments` is the cause and the other two are victims — fix `payments`.

The *error % of traffic* table tells you severity per service (100% = fully down for that path).

### 2. Find a failing request

**Explore → Tempo**:

```traceql
{ status = error }                                    # any failing trace
{ resource.service.name = "orders" && status = error } # scoped to one service
```

Open a trace: the span tree shows the exact call path and which span first errored.

### 3. Read every service's logs for that one request

Copy the trace id, then in **Explore → Loki**:

```logql
{service_name=~".+"} | trace_id=~`0*<trace-id>`
```

You get the full causal story across every service the request touched — the root-cause log line and
the cascading failures above it, in order.

> **Why `0*`:** Tempo's search API strips leading zeros from trace ids (returns 31 chars) while Loki
> stores the full 32-char value. An exact `trace_id="..."` match silently returns nothing for roughly
> 1 trace in 16. The `0*` prefix tolerates both forms. The Blast Radius dashboard's Trace ID box
> already does this for you.

### 4. Useful queries

```promql
# failing edges (blast radius)
sum by (client, server) (rate(traces_service_graph_request_failed_total[5m]))

# error rate per service — NOTE: label is `service`, not `service_name`
sum by (service) (rate(traces_spanmetrics_calls_total{
  status_code="STATUS_CODE_ERROR", span_kind="SPAN_KIND_SERVER"
}[5m]))

# p95 latency per service
histogram_quantile(0.95, sum by (le, service) (rate(traces_spanmetrics_latency_bucket[5m])))
```

```logql
{service_name=~".+"} | detected_level = `error`        # all errors, all services
{service_name="orders"} | orderId="abc-123"            # find one entity's logs
```

> **Label gotcha:** Tempo's generated metrics label the service `service`. Loki labels it
> `service_name`. The two genuinely differ — `sum by (service_name)` on span-metrics silently
> collapses every service into one unlabeled series instead of erroring.

### 5. Practise it

The microservices example has a fault-injection switch, so you can rehearse this whole flow safely:

```bash
# start the incident
curl -XPOST localhost:8083/admin/failure-mode -H 'content-type: application/json' -d '{"enabled":true}'
# ...work through steps 1–4...
# end it
curl -XPOST localhost:8083/admin/failure-mode -H 'content-type: application/json' -d '{"enabled":false}'
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `serviceName is required` on boot | Set `OTEL_SERVICE_NAME` (or pass `serviceName`). |
| `ERR_PACKAGE_PATH_NOT_EXPORTED` / `ERR_REQUIRE_ESM` | The package is **ESM-only**. Use `--import`, not `--require`, and set `"type": "module"`. |
| `getLogger() called before initObservability()` | Use the preload, or move `initObservability()` above every other import. |
| Traces appear, but a library isn't instrumented | It was imported before the SDK started. Use the preload. |
| **No data anywhere** | Is the Collector reachable? `curl -X POST $OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces -H 'Content-Type: application/json' -d '{}'` → expect 200. Then `docker compose logs otel-collector`. |
| Logs in Loki, but **no `trace_id`** | The log was emitted outside an active span (e.g. at startup) — expected. If *every* log lacks it, see the warning in [CLAUDE.md](./CLAUDE.md) about never reverting `logging.ts` to a worker-thread pino transport. |
| Log has `trace_id` but no **View Trace** link | Loki datasource derived field must be `matcherType: label` on `trace_id` (not a body regex), and Loki needs `allow_structured_metadata: true`. |
| Trace id from Tempo finds **no logs** | Leading zeros. Use ``trace_id=~`0*<id>` ``. |
| PromQL returns **one unlabeled series** | Wrong label — use `service`, not `service_name`, on Tempo-generated metrics. |
| RED / service-graph panels empty | Needs ~30s of fresh traffic after a stack restart. |
| Everything `Exited (255)` | Docker/WSL restarted. `docker compose up -d`. |
| `EADDRINUSE` on a port `ss` says is free | On WSL2 the port space is shared with Windows. Probe with a throwaway `net.createServer()` script. |

---

## Reference

- [`packages/observability/README.md`](./packages/observability/README.md) — full API reference
- [`examples/nodejs-sample/`](./examples/nodejs-sample/) — single-service example
- [`examples/microservices/`](./examples/microservices/) — multi-service + blast radius
- [`CLAUDE.md`](./CLAUDE.md) — architecture, design decisions, component versions
