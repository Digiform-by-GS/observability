# observability-baseline

A local LGTM (Loki, Grafana, Tempo, Mimir) + Pyroscope + OpenTelemetry Collector stack for building and testing observability-enabled applications. Mirrors production topology.

Contents:
1. **This repo's `docker-compose`** — the backend stack
2. **[`@digiform/observability`](./packages/observability/)** — a wrapper NPM package bundling the OTel SDK and sensible defaults
3. **[`examples/nodejs-sample`](./examples/nodejs-sample/)** — an Express app demonstrating the wrapper end-to-end
4. **[`examples/microservices`](./examples/microservices/)** — three chained services showing cross-service tracing and blast-radius analysis

---

## Quickstart

```bash
docker compose up -d
open http://localhost:3000           # Grafana, anonymous admin
```

Give it ~60s, then confirm readiness from the host (the Loki/Tempo/Mimir images are distroless, so they
carry no docker healthcheck — `docker compose ps` will never say "healthy"):

```bash
for p in 3100 3200 9009; do curl -s -o /dev/null -w "$p: %{http_code}\n" http://localhost:$p/ready; done
# expect 200 200 200 — 503 means still starting
```

Datasources and dashboards are pre-provisioned — no clicks required. Dashboards show "No data" until an
instrumented app sends traffic; run one of the examples above to fill them.

## Signal flow

```
App (OTLP :4318 HTTP or :4317 gRPC)
  └─► OTel Collector
        ├─ logs    ──► Loki   :3100
        ├─ traces  ──► Tempo  (internal)
        └─ metrics ──► Mimir  :9009

App (Pyroscope SDK) ──► Pyroscope :4040   profiles (which function allocates)

Tempo metrics generator ──► Mimir  (span-metrics + service-graphs)
Grafana :3000 ────────────► Loki, Tempo, Mimir
```

## Port map

| Port | Service |
|---|---|
| 3000 | Grafana |
| 3100 | Loki |
| 3200 | Tempo |
| 4317 | OTel Collector (OTLP gRPC) |
| 4318 | OTel Collector (OTLP HTTP) |
| 8888 | OTel Collector (self-metrics) |
| 9009 | Mimir |
| 4040 | Pyroscope (profiles) |
| 8080 / 8082 / 8083 | microservices example (checkout-api / orders / payments) |

## Send some test data

With the stack running, point any OTel-instrumented app at `http://localhost:4318` (HTTP) or `localhost:4317` (gRPC). No auth, no TLS.

Minimal shell test that the Collector is receiving traces:

```bash
curl -i http://localhost:4318/v1/traces \
  -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[]}'
# expect HTTP 200
```

## Reset the stack

```bash
docker compose down -v     # removes volumes too
docker compose up -d
```

## Documentation

- **[`GUIDE.md`](./GUIDE.md)** — start here. Quick Start, developer guide (instrumenting a service),
  operations guide (running the stack), and the incident playbook for "what's impacted?"
- [`packages/observability/README.md`](./packages/observability/README.md) — full API reference
- [`CLAUDE.md`](./CLAUDE.md) — architecture, design decisions, component versions
