# Claude Code Context — Observability Baseline

This file provides architectural context for future Claude Code sessions working in this repository.

---

## What This Repo Is

A monorepo that provides:
1. **LGTM + OTel Collector stack** — runs locally via Docker Compose; mirrors production topology
2. **`@digiform-by-gs/observability` wrapper package** — bundles OTel SDK + exporters so devs install one package
3. **`observability-go` module** — the Go counterpart, sharing the same env-var contract
4. **`examples/nodejs-sample`** — single Express app demonstrating the wrapper end-to-end
5. **`examples/microservices`** — three chained services demonstrating cross-service tracing and blast-radius analysis
6. **`examples/go-service`** — Go example (chi), containerised on the `obs` network
7. **`examples/go-echo-service`** — Go example using the Echo router (otelecho)

All are verified end-to-end against the running stack: traces, metrics, and trace-correlated logs land
in Tempo / Mimir / Loki and render in Grafana. `go-service` additionally exercises Redis, Postgres, and
event-driven RabbitMQ (publish→consume with span links). Infra monitored via collector receivers:
`redis`, `postgresql`, `rabbitmq`.

---

## Component Versions (pinned)

| Component | Image / Version |
|---|---|
| Grafana | `grafana/grafana:13.0.1` |
| Loki | `grafana/loki:3.7.1` |
| Tempo | `grafana/tempo:2.10.5` |
| Mimir | `grafana/mimir:3.0.6` |
| Pyroscope | `grafana/pyroscope:2.1.1` |
| OTel Collector Contrib | `otel/opentelemetry-collector-contrib:0.154.0` |
| Node.js | `^18.19.0 \|\| >=20.6.0` — the wrapper's `engines`, which is the binding floor (dev machine runs 24.11.0) |
| Go | **1.25+ required** by OTel v1.44. Dev machine runs 1.26.5 from `~/.local/go`, *not* the apt-installed 1.22 at `/usr/bin/go` |
| OTel Go SDK | `go.opentelemetry.io/otel` v1.44.0 |
| TypeScript | 5.x |

Docker Hub only retains recent stable `opentelemetry-collector-contrib` tags — older pins (0.150–0.153)
have been garbage-collected and will fail to pull. Verify a tag exists before pinning it.

---

## Signal Flow

```
App (OTLP/HTTP :4318 or gRPC :4317)
  └─► OTel Collector
        ├─ logs    ──► Loki   :3100  (OTLP push /otlp/v1/logs)
        ├─ traces  ──► Tempo  :4318  (OTLP HTTP, internal)
        └─ metrics ──► Mimir  :9009  (Prometheus remote_write /api/v1/push)

App (Pyroscope SDK, opt-in via PYROSCOPE_SERVER_ADDRESS)
  └─► Pyroscope :4040  (profiles — heap/wall by function)

Tempo metrics generator  ──► Mimir  (span-metrics + service-graphs, with exemplars)
Grafana :3000 ─────────► Loki, Tempo, Mimir, Pyroscope (pre-provisioned datasources)
```

Profiles bypass the Collector: OTLP profiling is still experimental, so the Pyroscope SDK pushes
directly. Profiling answers the one question the other three signals structurally cannot — *which
function* allocated the memory — because heap gauges are per-process and spans measure time, not
allocation.

---

## Key Design Decisions

### Why OTel Collector as the intermediary?
Apps talk OTLP to the Collector only. The Collector fans out to backends. This means:
- Swapping a backend (e.g. Loki → Elasticsearch) requires only a Collector config change — no app changes.
- The Collector handles batching, retry, backpressure, and memory limiting centrally.

### Why Mimir instead of Prometheus?
Mimir is Prometheus-API compatible but designed for horizontal scale. Grafana datasource uid `prometheus` points at Mimir so Tempo's service-map and exemplar links work without any extra wiring.

### Why OTLP for logs (not Promtail/Fluentd)?
Loki 3.x accepts native OTLP. Routing logs through the OTel Collector keeps all three signals on the same pipeline (one endpoint for apps, unified retry/batching). No Promtail sidecar needed.

### Why a wrapper NPM package?
OTel JS requires ~10 separate packages + non-trivial init order (SDK must initialize before any instrumented modules are loaded). The wrapper:
- Pins compatible OTel package versions together
- Encodes the correct init order
- Ships a pino logger whose records carry the active trace context
- Provides `getTracer()` / `getMeter()` / `getLogger()` for custom instrumentation

### Log ↔ Trace correlation (rewritten 2026-07-16 — read this before touching `logging.ts`)

`src/logging.ts` bridges pino → the OTel Logs API **in the main thread**: a plain in-process pino
destination stream JSON-parses each line and calls `logs.getLogger(...).emit(...)`. Because `emit()`
runs in the same synchronous frame as the log call, it captures `context.active()` and stamps
`trace_id`/`span_id` onto the OTLP LogRecord natively. Loki 3.x stores those as **structured metadata**
(gated by `limits_config.allow_structured_metadata: true`).

**This design is deliberate — do not "simplify" it back to a pino transport.** The original
implementation used `pino-opentelemetry-transport`, which runs in a **worker thread that has no OTel
context**, so `trace.getActiveSpan()` always returned undefined and every log reached Loki with an empty
TraceId. `@opentelemetry/instrumentation-pino` doesn't rescue this either: the bundled `preload.js`
imports pino *before* `initObservability()` registers instrumentations, so its module hook never patches
pino. It is explicitly disabled in `init.ts` to prevent double-emission.

Because trace_id is structured metadata and **not** in the log body, the Grafana Loki datasource uses
`matcherType: label` / `matcherRegex: trace_id` for its "View Trace" derived field. A body regex will
never match.

### Go services — `packages/observability-go/`

Go's correlation story is *simpler* than Node's — no worker-thread hazard, because `slog.Handler.Handle`
receives `ctx` directly — but it has two traps of its own:

1. **Go's default text-map propagator is a no-op.** Without `otel.SetTextMapPropagator`, every service
   starts a fresh trace: spans look individually correct, nothing ever joins up, and nothing errors.
   `New()` sets it, and `TestNewSetsTraceContextPropagator` guards it (verified to fail when removed).
2. **`logger.Info(...)` compiles, runs, and silently produces an uncorrelated log.** Only
   `InfoContext(ctx, ...)` carries the span. `.golangci.yml` enables `sloglint` with `context: all`
   for exactly this — **not optional**; it caught real defects the day it landed.

Server middleware comes from the **`httpx` module** (`httpx/chix`, `/ginx`, `/echox`, `/muxx`) — a
separate go.mod root, so services that serve no HTTP do not pull four routers. Never bare
`otelhttp` on a server: framework wrappers name spans after the route *template*, whereas raw paths
make `span_name` unbounded and inflate span-metrics cardinality until Mimir rejects writes for every
tenant. The per-router incantations differ (otelchi needs two options, otelmux needs a hand-written
formatter and has no option at all, otelgin/otelecho are already correct), which is exactly why this
is a module with tests rather than a paragraph of docs. On clients, `otelhttp.NewTransport` is what
injects `traceparent` — and an SDK that builds its own transport (`gocloak`, `resty`) propagates
nothing and severs the trace silently.

`httpx` pins opentelemetry-go-contrib to **v0.69.0**, the line built against otel v1.44.0. Newer
contrib (v0.71.0) pulls otel to v1.46 — and because Go selects the maximum version in the graph,
bumping httpx alone would silently raise otel for every service that also uses `observability-go`.
`scripts/check-compat.py` asserts the two stay together.

Go log keys are **snake_case** (`order_id`) to match Loki's resource-attribute spelling; the Node
examples emit camelCase (`orderId`), so a query spanning both stacks must handle both.

### Event-driven tracing over RabbitMQ — `packages/observability-go/amqp/`

Consumers start a **new root trace with a LINK to the producer**, not a parent-child child span (see
`consumer.go`, the `context.Background()` + `trace.WithLinks` call). Reasons: a message queued for
hours would otherwise produce a multi-hour trace whose latency is meaningless; fan-out to N queues
would branch one ever-growing trace instead of N clean ones; and a consume after Tempo's retention
window would dangle off a compacted-away parent. A link degrades gracefully; parenthood does not.

**Consequence you must not "fix": async edges are absent from the service graph.** Tempo's
service-graph pairs spans *within one trace*, and with links the producer and consumer are in
different traces — so there is no rabbitmq/queue edge in the node graph. This is correct. Switching to
parent-child to "restore" the edge reintroduces every problem above. Build the async view from
span-metrics instead: `sum by (span_kind, messaging_destination_name)
(traces_spanmetrics_calls_total{span_kind=~"SPAN_KIND_PRODUCER|SPAN_KIND_CONSUMER"})`. The messaging
dimensions come from `tempo-config.yaml` → `metrics_generator.processor.span_metrics.dimensions`
(note: `processor`, singular — wrong nesting rejects the whole `overrides.defaults` block).

The `HeaderCarrier` over `amqp091.Table` is written and unit-tested in-repo, not pulled from a
dependency, because AMQP headers are `map[string]interface{}`: `Get` must type-assert and return `""`
for a non-string, so a foreign producer's numeric header can't panic the consumer.

### Browser / RUM — `packages/observability-browser/`

Browser telemetry inverts three assumptions that hold on a server, and each
inversion is a silent failure:

1. **`localhost` means the visitor's machine.** The Node wrapper's
   `http://localhost:4318` default is safe because the process sits beside the
   collector. Copying it to the browser would work perfectly on a developer
   laptop and report nothing from a single real user, so `endpoint` is required
   with no default.
2. **`propagateTo` can break the host application.** Adding `traceparent` makes
   a cross-origin request *preflighted*; if the API does not allow the header
   the preflight fails and **the real request never happens**. It is opt-in and
   empty by default, and must be sequenced after the backend's CORS change.
3. **The exporter posts over `fetch`.** With fetch instrumented and nothing
   excluded, exporting a span produces a span. `ignoreUrls` on the endpoint is
   what breaks the loop, and without it every open tab floods the collector.

Ingest is a **separate collector receiver on 4319** — the only one with CORS,
which is what a browser requires and what makes an endpoint writable from any
page. Browser metrics get `resource/prune-browser-labels`: `user_agent.original`
is one value per browser build and `session.id` is unbounded, and Mimir's series
cap is global, so one frontend can get writes rejected for every service.

This package sits on a **newer OTel line than the Node wrapper** (SDK 2.10 /
experimental 0.221 vs 2.7 / 0.215) because `instrumentation-fetch` pins
`sdk-trace-web` to an exact version. They target different runtimes and are
never in one bundle, so they do not need to agree — but note the 0.221 signature
change: `BatchLogRecordProcessor`/`SimpleLogRecordProcessor` take `{ exporter }`,
and passed positionally they silently record nothing.

`instrumentation-user-interaction` is deliberately excluded — it names spans
after event type plus DOM target, which is unbounded.

### Signal-specific label gotchas
- Tempo's metrics generator labels spanmetrics/service-graph series **`service`**, *not* `service_name`.
  Querying `sum by (service_name)` silently collapses every service into one unlabeled series.
  `service_name` *is* correct for Loki queries — the two systems genuinely differ.
- Tempo's search API returns trace ids with **leading zeros stripped** (31 chars); Loki stores the full
  32-char value. Match with ``| trace_id=~`0*<id>` `` or ~1 lookup in 16 silently returns nothing.
- Exemplars need **two** settings to agree: `max_global_exemplars_per_user` non-zero in Mimir (0 =
  drop everything Tempo sends) and `exemplarTraceIdDestinations: name: traceID` (camelCase) in the
  Grafana datasource. Either wrong = a dead link with no error anywhere.
- **OTLP metric units become part of the Prometheus name, inconsistently.** `browser.web_vital.lcp`
  with unit `ms` arrives as `browser_web_vital_lcp_milliseconds_bucket`, but `browser.web_vital.cls`
  with unit `1` arrives as `browser_web_vital_cls_bucket` — no suffix. Guessing symmetry gives four
  working panels and one permanently empty one. `scripts/gen-dashboards.py` documents this; verify
  new metric names against `/prometheus/api/v1/label/__name__/values` rather than predicting them.
- Loki keeps `severity_text` as **structured metadata**, not a label — same as `trace_id`. Filter
  with `| severity_text="ERROR"` after the stream selector; a label matcher `{severity_text="ERROR"}`
  silently returns nothing.
- Pyroscope's Node SDK emits profile type `memory:inuse_space:bytes:inuse_space:bytes`. The Go-style
  `memory:inuse_space:bytes:space:bytes` returns an empty flame graph, not an error.
- **Series growth is dominated by span-metrics histograms, not by receivers.** Adding Redis +
  Postgres took Mimir from 48 → 709 series, but the `redis`/`postgresql` receivers accounted for
  only ~34 each. 52% came from Tempo's generator (`traces_spanmetrics_latency_bucket` alone = 240),
  because every *new span name* multiplies by the histogram bucket count — and instrumenting a
  client library introduces many (`sql.conn.query`, `sql.rows`, `incr`, `expire`, …). Budget for
  span names, not for receivers.

---

## Repository Layout

```
observability-baseline/
├── docker-compose.yml            # Full LGTM + OTel stack
├── infra/
│   ├── otel-collector/config.yaml
│   ├── loki/loki-config.yaml
│   ├── tempo/tempo-config.yaml
│   ├── mimir/mimir-config.yaml
│   └── grafana/
│       ├── grafana.ini
│       └── provisioning/
│           ├── datasources/datasources.yaml   # auto-wires Loki, Tempo, Mimir
│           └── dashboards/
│               ├── dashboard-provider.yaml
│               ├── default.json               # RED metrics + logs dashboard
│               └── blast-radius.json          # incident: cause vs. impact
├── .golangci.yml                 # sloglint context:all — REQUIRED, see Go section
├── scripts/check-compat.py        # asserts compat.json matches the packages (CI)
├── packages/
│   ├── observability/            # @digiform-by-gs/observability wrapper (Node)
│   ├── observability-browser/    # browser/RUM package — newer OTel line, see below
│   └── observability-go/         # observability-go module (Go)
│       └── httpx/                # SEPARATE module: chix/ginx/echox/muxx router middleware
└── examples/
    ├── nodejs-sample/            # single Express demo app
    ├── microservices/            # checkout-api → orders → payments chain
    ├── go-service/               # Go example (chi), containerised on `obs`
    └── go-echo-service/          # Go example (Echo router)
```

Grafana's provisioning tree is mounted **per-directory, not wholesale**: the base file mounts
`datasources/` and `dashboards/`, and `docker-compose.platform.yml` adds `alerting/`. Alerting
references `$__env{DISCORD_WEBHOOK_URL}`, and Grafana treats a missing or empty value as a **fatal**
provisioning error — the entire server refuses to start, dashboards included. Mounting the whole
tree meant a clean `docker compose up` died with a message about Discord for someone who never
asked for alerting. Consequence: **local dev has no alert rules at all**, which is intended —
alerts are a shared-platform concern and Discord is the platform's channel.

`docker-compose.yml` deliberately has **no healthchecks** on Loki/Tempo/Mimir: those images are
distroless (no shell, no wget/curl), so any `CMD-SHELL` probe fails forever and marks them `unhealthy`.
`depends_on` uses `service_started`. Check readiness from the host instead (`curl :3100/ready`).

---

## Common Commands

```bash
# Start the full stack
docker compose up -d

# Tail collector logs (useful for debugging signal routing)
docker compose logs -f otel-collector

# Check all services are healthy
docker compose ps

# Stop and remove volumes (full reset)
docker compose down -v

# Restart a single service after config edits (no rebuild — configs are bind-mounted)
docker compose restart otel-collector

# Readiness (docker healthchecks are intentionally absent — see Repository Layout)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/ready   # Loki  (also :3200 Tempo, :9009 Mimir)

# Wrapper: build + test after editing packages/observability
npm run -w @digiform-by-gs/observability build && npm run -w @digiform-by-gs/observability test

# Go module: test + lint (the lint is load-bearing — see the Go section)
cd packages/observability-go && go test ./... && golangci-lint run --config ../../.golangci.yml ./...

# httpx is a SEPARATE module - `go test ./...` in the parent does not reach it
cd packages/observability-go/httpx && go test ./...

# Version pins agree with the packages (CI runs this; run it before any bump)
python3 scripts/check-compat.py

# Go example service (containerised on `obs`, reaches the collector by DNS)
docker compose build go-service && docker compose up -d go-service
curl localhost:8090/work

# Single sample app
OTEL_SERVICE_NAME=nodejs-sample npm run -w @digiform-by-gs/nodejs-sample start

# Microservices chain (one terminal each)
npm run -w @digiform-by-gs/microservices-demo start:payments   # :8083
npm run -w @digiform-by-gs/microservices-demo start:orders     # :8082
npm run -w @digiform-by-gs/microservices-demo start:checkout   # :8080

# Trigger / clear the demo incident
curl -XPOST localhost:8083/admin/failure-mode -H 'content-type: application/json' -d '{"enabled":true}'
```

First boot of any app from `/mnt/d` takes ~90–175s (WSL2 9P filesystem bridge) — it is not hung.

---

## Port Map

| Port | Service | Purpose |
|---|---|---|
| 3000 | Grafana | Web UI |
| 3100 | Loki | HTTP API + OTLP push |
| 3200 | Tempo | HTTP API (Grafana datasource) |
| 4317 | OTel Collector | OTLP gRPC receiver |
| 4318 | OTel Collector | OTLP HTTP receiver |
| 4319 | OTel Collector | OTLP HTTP receiver for BROWSERS — the only one with CORS |
| 8888 | OTel Collector | Self-metrics (Prometheus) |
| 9009 | Mimir | Prometheus-compatible API |
| 4040 | Pyroscope | Continuous profiling ingest + UI |
| 8090 | go-service | Go example, chi router (containerised on `obs`) |
| 8091 | go-echo-service | Go example, Echo router (host-run) |
| 6379 | Redis | cache — monitored by the collector's `redis` receiver |
| 5432 | Postgres | database — monitored by the `postgresql` receiver |
| 5672 | RabbitMQ | AMQP — what the app connects to |
| 15672 | RabbitMQ | management API/UI — what the `rabbitmq` receiver scrapes |
| 8080 | checkout-api | microservices demo — edge service |
| 8082 | orders | microservices demo — middle service |
| 8083 | payments | microservices demo — leaf + fault injection |

Tempo's internal OTLP ports (4317/4318) are not mapped to the host — only the Collector's are.

**Port 8081 is unusable on the current dev machine.** A Windows-side process holds it; WSL2 shares the
port space, so the bind fails with `EADDRINUSE` on `:::8081` while `ss`/`netstat` inside Linux show
nothing. Probe bindability with a throwaway `net.createServer()` script rather than trusting `ss`.

---

## Grafana Quick Navigation

- **Dashboards → Observability → Observability Overview**: RED metrics + log stream
- **Dashboards → Observability → Blast Radius**: failing dependency edges, impacted services, and a
  `trace_id` textbox that pulls one request's logs from every service it touched
- **Dashboards → Observability → Platform Health**: the stack's own health — component up/down,
  collector export failures and queue depth, discarded writes, and Mimir's series count against the
  150k cap. This is where the `platform-internal` alerts point; before it, they fired with nowhere
  to look
- **Dashboards → Observability → Browser (RUM)**: Core Web Vitals at p75 by route template, vitals
  rating mix, browser span latency, and JS errors
- **Explore → Loki**: raw log search; click "View Trace" on any log with a trace_id
- **Explore → Tempo**: TraceQL query interface (`{ status = error }`); Service Graph tab for the map
- **Explore → prometheus**: raw PromQL for span metrics from Tempo's generator (datasource points at Mimir)

---

## Troubleshooting Checklist

| Symptom | Check |
|---|---|
| No metrics in dashboard | Is sample app running? Metrics only appear once spans flow |
| Loki "no logs" | Check `docker compose logs otel-collector` for export errors |
| Tempo "no traces" | Verify app sends to `:4318` (HTTP) or `:4317` (gRPC) on the Collector, not on Tempo |
| Mimir 500 on startup | Normal — Mimir initialises its ring; retries resolve in ~30s |
| Grafana datasource error | Services may still be starting; wait 60s then reload |
| Logs show trace_id but no "View Trace" link | Confirm `allow_structured_metadata: true` in Loki config, and that the Loki datasource derived field uses `matcherType: label` (not a body regex) |
| Logs arrive with **no** trace_id at all | Something reintroduced a worker-thread pino transport. `logging.ts` must bridge to `logs.getLogger().emit()` on the main thread — see "Log ↔ Trace correlation" |
| PromQL returns one unlabeled series | Wrong label: Tempo's generated metrics use `service`, not `service_name` |
| A trace id from Tempo finds no logs in Loki | Leading zeros stripped by Tempo's API — match ``trace_id=~`0*<id>` `` |
| Everything `Exited (255)` after a reboot | Docker Desktop/WSL restarted; just `docker compose up -d` again |
| Service-graph / spanmetrics panels empty | Tempo's generator needs ~30s of *fresh* traffic after a stack restart before series reappear |
| `EADDRINUSE` on a port `ss` says is free | WSL2 shares the port space with Windows — see the Port Map note on 8081 |
| Go: each service is its own single-span trace | The global propagator was not set (Go's default is a no-op). `observability.New()` must run before any instrumented call |
| Go: logs in Loki with no `trace_id` | A bare `slog.Info` was used instead of `InfoContext(ctx, ...)`. Run `golangci-lint` — `sloglint` catches it; the compiler will not |
| Go: `go build` fails on OTel imports | Wrong toolchain. OTel v1.44 needs Go ≥ 1.25; check `go version` resolves to `~/.local/go`, not `/usr/bin/go` (1.22) |
| Go: every OTLP export 404s | `WithEndpoint` used instead of `WithEndpointURL`, giving `/v1/traces/v1/traces` — the SDK appends the suffix itself |

---

## The onboarding plugin mirrors the docs — keep them in lockstep

`plugin/` is a distributable Claude Code plugin (marketplace manifest at
`.claude-plugin/marketplace.json`) whose skills are **self-contained copies**
of the knowledge in `developer_guide.md` / `platform_guide.md` / this file —
client repos cannot see this monorepo, so the skills cannot link back here.
That is a deliberate trade: distribution requires duplication.

Consequence: **any change to a library's public API, the env-var contract, or
an operational gotcha needs a matching `plugin/skills/` update in the same
PR.** CI enforces the mechanical half (valid manifests, shellcheck, no
deployment-specific IPs, no monorepo doc references inside skills); the
content half is on you.

**Versions are the exception — those CI does enforce.**
`plugin/skills/onboard/references/compat.json` is the only version source the
agent can see (the runner mounts `plugin/` and nothing else), and
`scripts/check-compat.py` asserts it against the packages and both READMEs. So
a version bump anywhere means editing compat.json in the same PR or CI fails.
That guard exists because both onboarding defects shipped to a real client were
a wrong version picked where nothing authoritative said otherwise: a
two-major-stale `@vercel/otel`, and a `package.json` change with no lockfile. The rehearsal fixtures `examples/plain-express` and
`examples/plain-chi` are deliberately uninstrumented "before" apps for testing
the onboard skill — do not instrument them.

## Out of Scope (v1)

- Kubernetes / Helm deployment
- TLS between components
- Sampling strategies
- Authentication on Grafana (anonymous admin is enabled for local dev)
- Multi-language SDKs (Python, Go)
