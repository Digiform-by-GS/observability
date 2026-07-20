# Claude Code Context — Observability Baseline

This file provides architectural context for future Claude Code sessions working in this repository.

---

## What This Repo Is

A monorepo that provides:
1. **LGTM + OTel Collector stack** — runs locally via Docker Compose; mirrors production topology
2. **`@digiform/observability` wrapper package** — bundles OTel SDK + exporters so devs install one package
3. **`examples/nodejs-sample`** — single Express app demonstrating the wrapper end-to-end
4. **`examples/microservices`** — three chained services demonstrating cross-service tracing and blast-radius analysis

All four are complete and verified end-to-end against the running stack (2026-07-20): traces, metrics, and
trace-correlated logs all land in Tempo / Mimir / Loki and render in Grafana.

---

## Component Versions (pinned)

| Component | Image / Version |
|---|---|
| Grafana | `grafana/grafana:13.0.1` |
| Loki | `grafana/loki:3.7.1` |
| Tempo | `grafana/tempo:2.10.5` |
| Mimir | `grafana/mimir:3.0.6` |
| OTel Collector Contrib | `otel/opentelemetry-collector-contrib:0.154.0` |
| Node.js | 20 LTS minimum (dev machine runs 24.11.0) |
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

Tempo metrics generator  ──► Mimir  (span-metrics + service-graphs)
Grafana :3000 ─────────► Loki, Tempo, Mimir (pre-provisioned datasources)
```

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

### Signal-specific label gotchas
- Tempo's metrics generator labels spanmetrics/service-graph series **`service`**, *not* `service_name`.
  Querying `sum by (service_name)` silently collapses every service into one unlabeled series.
  `service_name` *is* correct for Loki queries — the two systems genuinely differ.
- Tempo's search API returns trace ids with **leading zeros stripped** (31 chars); Loki stores the full
  32-char value. Match with ``| trace_id=~`0*<id>` `` or ~1 lookup in 16 silently returns nothing.

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
├── packages/
│   └── observability/            # @digiform/observability wrapper
└── examples/
    ├── nodejs-sample/            # single Express demo app
    └── microservices/            # checkout-api → orders → payments chain
```

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
npm run -w @digiform/observability build && npm run -w @digiform/observability test

# Single sample app
OTEL_SERVICE_NAME=nodejs-sample npm run -w @digiform/nodejs-sample start

# Microservices chain (one terminal each)
npm run -w @digiform/microservices-demo start:payments   # :8083
npm run -w @digiform/microservices-demo start:orders     # :8082
npm run -w @digiform/microservices-demo start:checkout   # :8080

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
| 8888 | OTel Collector | Self-metrics (Prometheus) |
| 9009 | Mimir | Prometheus-compatible API |
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

---

## Out of Scope (v1)

- Kubernetes / Helm deployment
- TLS between components
- Sampling strategies
- Authentication on Grafana (anonymous admin is enabled for local dev)
- Multi-language SDKs (Python, Go)
