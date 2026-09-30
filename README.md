# observability

An OpenTelemetry observability platform built on the Grafana stack: traces, metrics,
trace-correlated logs and continuous profiling, with **multi-tenancy by team**.

It is assembled from open-source components rather than written from scratch — Loki,
Grafana, Tempo, Mimir, Pyroscope and the OpenTelemetry Collector — and adds the parts
those projects leave to you: a tenancy model, client libraries that get correlation
right, dashboards that answer operational questions, and an agent that instruments a
service for you.

Comparable in scope to an all-in-one APM such as SigNoz, with tenancy as the reason to
assemble it here instead: isolating teams' quotas and blast radius from each other is
the requirement that drove this, and it is not something the single-tenant
self-hosted options give you. Profiles and browser RUM come along with the Grafana
stack.

## What is in here

| | |
|---|---|
| **Backend stack** | `docker-compose.yml` for local development; `docker-compose.platform.yml` overlays the shared multi-tenant deployment |
| **[`@digiform-by-gs/observability`](./packages/observability/)** | Node wrapper — bundles the OTel SDK, pins compatible versions, encodes the init order, and ships a pino logger whose records carry the active trace |
| **[`observability-go`](./packages/observability-go/)** | Go counterpart, same env-var contract. `httpx/` is a separate module with router middleware for chi, gin, echo and mux |
| **[`@digiform-by-gs/observability-browser`](./packages/observability-browser/)** | Browser/RUM — Core Web Vitals, page loads, JS errors |
| **[`services/onboarding-agent`](./services/onboarding-agent/)** | Instrumentation agent: point it at a repository and it opens a pull request — or a merge request on GitLab — adding telemetry |
| **[`plugin/`](./plugin/)** | The same knowledge as a distributable Claude Code plugin — `onboard`, `verify`, `instrument`, `dashboards` skills |
| **[`examples/`](./examples/)** | Node (Express), a three-service chain, Go (chi), Go (Echo), plus two deliberately *uninstrumented* apps used to rehearse the onboarding agent |

## Quickstart — local stack

```bash
docker compose up -d
open http://localhost:3000           # Grafana, anonymous admin
```

Give it ~60s, then confirm readiness from the host. The Loki/Tempo/Mimir images are
distroless, so they carry no docker healthcheck and `docker compose ps` will never say
"healthy" — check from outside instead:

```bash
for p in 3100 3200 9009; do curl -s -o /dev/null -w "$p: %{http_code}\n" http://localhost:$p/ready; done
# expect 200 200 200 — 503 means still starting
```

Datasources and dashboards are pre-provisioned. Dashboards read "No data" until an
instrumented app sends traffic — run one of the examples to fill them:

```bash
docker compose build go-service && docker compose up -d go-service
curl localhost:8090/work
```

Local dev has **no alert rules and no tenancy**, both deliberate: alerting is a
shared-platform concern, and a single developer has no second tenant to isolate from.

## Instrumenting a service

Three routes, same result:

- **The agent** — `services/onboarding-agent` serves a form, clones the repository,
  instruments it on a branch, and opens the request against GitHub or GitLab. Nothing
  to install locally.
- **The plugin** — install the marketplace manifest and run the `onboard` skill in the
  service's own repo.
- **By hand** — [`developer_guide.md`](./developer_guide.md) has the install, the API
  reference for both libraries, and the compatibility matrix.

Afterwards, prove it actually works rather than assuming: the `verify` skill (or
[`GUIDE.md`](./GUIDE.md)) reads the trace, a correlated log and the metrics back out of
the backends.

## Multi-tenancy

On the platform deployment only. **The tenant is the team**, routed on the `team`
resource attribute that onboarded services already set — so no service declares a
tenant of its own, and onboarding needed no client change.

Everything per-tenant is generated from [`infra/tenants.yaml`](./infra/tenants.yaml);
CI fails if the outputs drift from the manifest. What tenancy buys today is quota and
blast-radius isolation, not access control — one shared Grafana reads every tenant,
because Grafana OSS has no datasource permissions.

See [`platform_guide.md`](./platform_guide.md) to operate it, and the tenancy section of
[`CLAUDE.md`](./CLAUDE.md) for the traps — several are silent failures.

## Signal flow

```
App (OTLP :4318 HTTP or :4317 gRPC)        Browser (OTLP :4319 — CORS)
  └─────────────► OTel Collector ◄──────────────┘
        ├─ logs    ──► Loki   :3100
        ├─ traces  ──► Tempo  (internal)
        └─ metrics ──► Mimir  :9009

App (Pyroscope SDK) ──► Pyroscope :4040    profiles — which function allocated

Tempo metrics generator ──► Mimir          span-metrics + service graphs, with exemplars
Grafana :3000 ──────────► Loki, Tempo, Mimir, Pyroscope
```

Apps speak OTLP to the Collector only; the Collector fans out. Swapping a backend is a
Collector config change, not an app change. Profiles bypass it because OTLP profiling is
still experimental.

## Dashboards

| Dashboard | Answers |
|---|---|
| **Service Inventory** | What services exist, who owns them, how they are doing — and whether each one is *fully* onboarded. A service sending traces but no logs shows up here and nowhere else |
| **Observability Overview** | RED metrics and logs, filtered by Team → Service → Environment |
| **Blast Radius** | During an incident: failing dependency edges, impacted services, and one request's logs across every service it touched |
| **Platform Health** | Whether the observability stack itself is working — the one question the others structurally cannot answer |
| **Browser (RUM)** | Core Web Vitals at p75 by route, plus JS errors |

## Port map

| Port | Service | |
|---|---|---|
| 3000 | Grafana | web UI |
| 3100 | Loki | HTTP API + OTLP push |
| 3200 | Tempo | HTTP API |
| 4317 / 4318 | OTel Collector | OTLP gRPC / HTTP |
| 4319 | OTel Collector | OTLP HTTP for **browsers** — the only receiver with CORS |
| 8888 | OTel Collector | self-metrics |
| 9009 | Mimir | Prometheus-compatible API |
| 4040 | Pyroscope | profiling ingest + UI |
| 8090 / 8091 | go-service / go-echo-service | Go examples |
| 8080 / 8082 / 8083 | checkout-api / orders / payments | microservices example |

On the platform deployment the backend ports are **not** published — Grafana reaches
them over the compose network, and publishing them would expose unauthenticated
push and query APIs to the LAN.

## Reset

```bash
docker compose down -v     # removes volumes too
docker compose up -d
```

## Documentation

- **[`GUIDE.md`](./GUIDE.md)** — start here. Quick start, operations, and the incident
  playbook for "what's impacted?"
- [`developer_guide.md`](./developer_guide.md) — instrumenting a service: install, API
  reference for both libraries, migration, and the compatibility matrix
- [`platform_guide.md`](./platform_guide.md) — operating the shared multi-tenant platform
- [`deployment_guide.md`](./deployment_guide.md) — Kubernetes blueprint, and the settings
  that silently break correlation
- [`infra/TENANTS.md`](./infra/TENANTS.md) — generated per-tenant summary
- [`CLAUDE.md`](./CLAUDE.md) — architecture, design decisions, pinned versions, and the
  failure modes that produce no error anywhere
