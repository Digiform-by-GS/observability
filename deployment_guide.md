# Deployment Guide — Kubernetes

How to run this observability stack on Kubernetes, and — more importantly — the
configuration that must carry across or correlation silently breaks.

---

## Read this first: what is and isn't tested

- **The `docker-compose` stack in this repo is verified end-to-end.** Traces,
  metrics, trace-correlated logs, exemplars, and profiles all work and are
  exercised in [`GUIDE.md`](./GUIDE.md).
- **This Kubernetes guide is a blueprint, not tested manifests.** Kubernetes is
  explicitly out of scope for v1 (see [`CLAUDE.md`](./CLAUDE.md)). The commands
  and values below are a grounded starting point derived from the working
  compose configs — treat every manifest as something you adapt and verify in
  your own cluster, not copy-paste-and-ship.

**The single most important thing to understand:** the LGTM configs in
[`infra/`](./infra/) run each backend as a **single binary with in-memory rings,
filesystem storage, and `replication_factor: 1`**. That is correct for local
dev and *wrong* for a production cluster — no persistence guarantees, no
redundancy, no horizontal scale. **Do not lift those configs into Kubernetes
Deployments as-is.** Use the official Grafana Helm charts for the backends
(which give you distributed mode + object storage), and carry over only the
*tuning settings* that this repo got right. This guide tells you which ones.

---

## Architecture on Kubernetes

```
┌─────────────────────────── your namespace(s) ───────────────────────────┐
│  App pods ── OTLP :4318 ──►  OTel Collector (gateway Deployment, HPA)     │
│  (env-var contract)                    │                                  │
│                                        ├─► Loki    (logs)                 │
│  App infra (Redis / Postgres /         ├─► Tempo   (traces)               │
│  RabbitMQ) ◄── scraped by ──           └─► Mimir   (metrics)              │
│      a SEPARATE single-replica                                            │
│      collector (see "Infra receivers")                                    │
│                                                                           │
│  App pods ── Pyroscope SDK ─────────►  Pyroscope (profiles)               │
└───────────────────────────────────────────────────────────────────────────┘
         Tempo metrics-generator ──► Mimir (span-metrics + exemplars)
         Grafana ──► Loki, Tempo, Mimir, Pyroscope (datasources as ConfigMaps)
         Backends ──► object storage (S3 / GCS / Azure Blob), NOT a PVC at scale
```

**Namespaces:** put the backends in `observability` and your apps in their own
namespaces. Apps reach the collector cross-namespace at
`http://otel-collector.observability.svc.cluster.local:4318`.

---

## Prerequisites

- A cluster (1.27+), `kubectl`, and `helm` 3.x.
- **Object storage** for Loki/Tempo/Mimir/Pyroscope: an S3/GCS/Azure bucket (or
  in-cluster MinIO for non-prod). Filesystem PVCs work for a pilot but do not
  scale and complicate backups — plan for object storage.
- A metrics story for the cluster itself is assumed separate (kube-state-metrics
  etc.); this stack is for *application* observability.

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update
kubectl create namespace observability
```

---

## Part 1 — Backends (Grafana Helm charts)

Use the official charts. For each, the table maps the **repo config that must
carry over** (left) to where it lives in the chart (right). Getting these wrong
does not error — it silently breaks correlation or storage.

### Loki — `grafana/loki`

Start with `deploymentMode: SingleBinary` for a pilot; move to
`SimpleScalable` or `Distributed` for production.

| Repo setting (`infra/loki/loki-config.yaml`) | Why it matters | Chart location |
|---|---|---|
| `limits_config.allow_structured_metadata: true` | **trace_id is stored as structured metadata.** Off = no log→trace link, no error | `loki.limits_config.allow_structured_metadata` |
| `compactor.retention_enabled: true` + `retention_period` | Without `retention_enabled`, `retention_period` is inert and disk grows forever | `loki.limits_config.retention_period`, `loki.compactor.retention_enabled` |
| filesystem storage | Replace with object storage | `loki.storage.type: s3` (+ bucket config) |

### Tempo — `grafana/tempo` (single) or `grafana/tempo-distributed`

The metrics-generator config is the fiddly part and the source of several
session-long bugs.

| Repo setting (`infra/tempo/tempo-config.yaml`) | Why it matters | Chart location |
|---|---|---|
| `compactor.compaction.block_retention: 168h` | 1h default deletes traces before you can investigate; event-driven flows exceed 1h | `tempo.compactor` / overrides |
| `metrics_generator ... remote_write ... send_exemplars: true` | Exemplars are what make metric→trace links possible | `metricsGenerator.remoteWrite[].sendExemplars: true` |
| `overrides.defaults.metrics_generator.processors: [service-graphs, span-metrics, local-blocks]` | No processors = no span-metrics, no service graph | `metricsGenerator` / `global_overrides` |
| `metrics_generator.processor.span_metrics.dimensions: [messaging.*]` | Adds the async (RabbitMQ) dimensions. **`processor` is singular** — wrong nesting rejects the whole overrides block | `global_overrides.defaults.metrics_generator.processor.span_metrics.dimensions` |

Point the generator's `remote_write` at the Mimir push endpoint
(`http://mimir-nginx.observability.svc/api/v1/push` — the exact service name
depends on the Mimir chart).

### Mimir — `grafana/mimir-distributed`

The cardinality limits are **load-bearing** on Kubernetes, where a bad
deployment can multiply series fast (see "Infra receivers" below).

| Repo setting (`infra/mimir/mimir-config.yaml`) | Why it matters | Chart location |
|---|---|---|
| `max_global_series_per_user`, `max_global_series_per_metric`, `max_label_names_per_series` | The only thing between a cardinality mistake and an OOM; they reject loudly | `mimir.structuredConfig.limits` |
| `max_global_exemplars_per_user: 100000` | **0 (default) silently drops every exemplar Tempo sends** | `mimir.structuredConfig.limits.max_global_exemplars_per_user` |
| `native_histograms_ingestion_enabled: true` | The generator emits native histograms | same block |
| filesystem storage | Replace with object storage | `mimir.structuredConfig.blocks_storage` / chart's `minio` or bucket values |

### Pyroscope — `grafana/pyroscope`

Continuous profiling. Apps push directly (opt-in via `PYROSCOPE_SERVER_ADDRESS`,
pointed at the Pyroscope service). No collector involvement. Object storage for
production; a PVC is acceptable for a pilot.

---

## Part 2 — OpenTelemetry Collector

Deploy with `open-telemetry/opentelemetry-collector` (or the OpenTelemetry
Operator's `OpenTelemetryCollector` CRD, which also unlocks auto-instrumentation
injection). The collector config in [`infra/otel-collector/config.yaml`](./infra/otel-collector/config.yaml)
transfers **almost verbatim** — only the exporter endpoints change to Kubernetes
service DNS.

### Two collectors, not one — this is a Kubernetes-specific gotcha

- **Gateway (Deployment, `mode: deployment`, 2+ replicas + HPA):** receives OTLP
  from apps, fans out to Loki/Tempo/Mimir. Stateless, scales horizontally. This
  carries the `otlp` receiver and the `logs`/`traces`/`metrics` pipelines.

- **Infra scraper (a SEPARATE Deployment, exactly 1 replica):** runs the
  `redis`, `postgresql`, and `rabbitmq` receivers (the `metrics/infra`
  pipeline). **These must not run on a multi-replica collector** — three
  replicas each scraping Redis is 3× the series for the same data, and on
  Kubernetes that is exactly how you blow the `max_global_series_per_user` limit
  you just set. One replica, or use the Target Allocator to shard.

Keep them separate for the same reason the compose config uses a separate
`metrics/infra` pipeline: a stalled infra scrape must not backpressure app
telemetry.

### Endpoint changes (compose DNS → K8s service DNS)

```yaml
exporters:
  otlp_http/logs:   { endpoint: http://loki-gateway.observability.svc/otlp }
  otlp_http/traces: { endpoint: http://tempo.observability.svc:4318 }
  prometheus_remote_write:
    endpoint: http://mimir-nginx.observability.svc/api/v1/push
    resource_to_telemetry_conversion: { enabled: true }   # keep — but see cardinality note
```

### Carry these over unchanged

- `memory_limiter` with `limit_mib` **below** the pod's memory limit, so the
  graceful limiter trips before the kernel OOM killer (same reasoning as the
  compose `mem_limit`). Set the pod limit ~30% above `limit_mib`.
- The `resource` processor stamping `deployment.environment` from an env var
  (`action: insert`, so app-set values win). On Kubernetes this becomes a pod
  env var or a downward-API value — **set it per environment**, or infra
  metrics say `dev` while apps say `prod` and dashboards show half the data.

### Where apps send telemetry

```
OTEL_EXPORTER_OTLP_ENDPOINT = http://otel-collector.observability.svc.cluster.local:4318
```

---

## Part 3 — Grafana

Deploy `grafana/grafana`. The datasources and dashboards in
[`infra/grafana/provisioning/`](./infra/grafana/provisioning/) become
**ConfigMaps**, mounted via the chart's sidecar (label
`grafana_datasource: "1"` / `grafana_dashboard: "1"`), or provided through
`grafana.datasources` / `grafana.dashboardProviders` values.

Only the datasource **URLs** change (to K8s service DNS). Everything else in
[`datasources.yaml`](./infra/grafana/provisioning/datasources/datasources.yaml)
must survive intact — these are the correlation wiring:

| Setting | Consequence if wrong |
|---|---|
| Loki `derivedFields` → `matcherType: label`, `matcherRegex: trace_id` | A body-regex matcher never matches structured-metadata trace_id → dead "View Trace" |
| prometheus `exemplarTraceIdDestinations` → **`name: traceID`** (camelCase) | Tempo names the exemplar label `traceID`; `trace_id` = silently dead exemplar link |
| Tempo `tracesToLogsV2` / `tracesToMetrics` / `tracesToProfiles` | The cross-signal jumps from a trace |
| datasource `uid`s (`loki`/`tempo`/`prometheus`/`pyroscope`) | Dashboards reference these by uid — renaming breaks every panel |

```bash
kubectl -n observability create configmap grafana-datasources \
  --from-file=infra/grafana/provisioning/datasources/datasources.yaml \
  --dry-run=client -o yaml | kubectl label -f - --local -o yaml \
  grafana_datasource=1 > /tmp/ds.yaml   # then edit URLs, then apply
```

Put Grafana behind an Ingress with TLS and real auth (see Security).

---

## Part 4 — Instrumenting your apps

Nothing about the app code changes between compose and Kubernetes — the whole
point of the env-var contract. Set these on every workload (Go, Node, Next.js):

```yaml
env:
  - name: OTEL_SERVICE_NAME            # required; unique per service, low-cardinality
    value: orders
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: http://otel-collector.observability.svc.cluster.local:4318
  - name: OTEL_DEPLOYMENT_ENVIRONMENT
    value: production
  - name: OTEL_SERVICE_VERSION
    valueFrom: { fieldRef: { fieldPath: metadata.labels['app.kubernetes.io/version'] } }
  - name: OTEL_RESOURCE_ATTRIBUTES     # optional; team/region etc.
    value: "team=payments"
```

- **Never put a pod name or commit SHA in `OTEL_SERVICE_NAME`** — it becomes an
  indexed label; keep it stable and low-cardinality.
- Go: still use `otelchi`/`otelgin` (route templates), not raw paths, or
  `span_name` cardinality explodes — doubly true across many pods.
- For the RabbitMQ receiver / Redis / Postgres receivers to work, the *infra
  scraper* collector must be able to resolve and reach those services (same
  namespace or a NetworkPolicy that allows it).

---

## The settings that silently break correlation — consolidated checklist

Every one of these fails **without an error**. This is the section to re-read
before declaring the deployment done.

- [ ] Loki `allow_structured_metadata: true` — or logs have no `trace_id`.
- [ ] Grafana Loki datasource uses `matcherType: label` on `trace_id` — a body regex won't match.
- [ ] Mimir `max_global_exemplars_per_user` non-zero **and** Grafana exemplar destination named **`traceID`** — both, or the metric→trace link is dead.
- [ ] Tempo generator `send_exemplars: true` and `processors` include `span-metrics` + `service-graphs`.
- [ ] PromQL uses **`service`** (Tempo's span-metrics label), not `service_name`; Loki uses **`service_name`**. They genuinely differ.
- [ ] Trace-id lookups in LogQL use `` trace_id=~`0*<id>` `` — Tempo strips leading zeros, Loki stores all 32 chars.
- [ ] `deployment.environment` set consistently on the collector **and** apps.
- [ ] Mimir cardinality limits set — and verified to reject (see Verification).
- [ ] Infra receivers run on a **single** collector replica — no duplicate scrapes.
- [ ] RabbitMQ async flows: **no service-graph edge is expected** (span links, separate traces). Build the async view from span-metrics; don't "fix" it into parent-child.

---

## Sizing & resources

The compose `mem_limit`s reflect *idle local* usage and are a floor, not a
production sizing:

| Component | Compose limit | Measured idle | Production reality |
|---|---|---|---|
| Mimir | 512 MiB | ~50 MiB | Sized by **active series**; distributed ingesters need GiBs |
| Tempo | 512 MiB | ~55 MiB | Sized by ingest rate + block-building |
| Loki | 384 MiB | ~70 MiB | Sized by log volume + chunk cache |
| Collector | 512 MiB | — | Sized by throughput; scale replicas horizontally |

Size from your **real cardinality and ingest rate**, not these numbers. Set pod
`requests`/`limits` per component; keep the collector's internal `memory_limiter`
below its pod limit. Use HPAs on the gateway collector and Mimir/Loki write
paths. Recall the Phase 2 lesson: **series growth is dominated by span-metrics
histograms (span names × buckets), not by receivers** — budget by span name.

---

## Security (the parts the dev stack deliberately skips)

The compose stack is intentionally open (anonymous Grafana, `insecure: true`, no
TLS). None of that is acceptable in a shared cluster:

- **TLS** between apps↔collector↔backends (OTLP supports TLS; drop `insecure`).
- **Grafana auth** — disable anonymous, wire OIDC (this is where a Keycloak,
  once deployed, secures the telemetry describing your apps).
- **Multi-tenancy** — Loki/Mimir/Tempo support tenant isolation via
  `X-Scope-OrgID`; the dev stack disables it.
- **NetworkPolicies** — only apps may reach the collector; only the collector
  and Grafana may reach the backends; nothing reaches storage credentials.
- **Secrets** — object-storage keys and datasource credentials via `Secret`
  objects / external-secrets, never in ConfigMaps or images.
- **Do not expose the collector's OTLP ports off-cluster** without auth.

---

## Health & readiness probes

A direct translation of a dev-stack lesson: the Loki/Tempo/Mimir images are
**distroless** (no shell), so `exec` probes fail forever. Use **HTTP probes**:

```yaml
readinessProbe:
  httpGet: { path: /ready, port: 3100 }   # Loki
  initialDelaySeconds: 15
livenessProbe:
  httpGet: { path: /ready, port: 3100 }
```

Ports: Loki `3100`, Tempo `3200`. **Mimir differs by deployment**: this repo's
monolith config listens on `9009` (`infra/mimir/mimir-config.yaml`), while the
`mimir-distributed` chart's components listen on `8080` — use whichever matches
how you deployed it. The Grafana charts set these probes correctly; the caveat
applies only if you hand-roll a Deployment.

The Grafana charts set these correctly already; if you hand-roll a Deployment,
use HTTP, not `CMD-SHELL`. Expect Loki/Tempo to hold `/ready` at 503 for ~15s
after the ingester comes up — set `initialDelaySeconds` accordingly.

---

## Verification after deploy

Run the same round-trips that validate the compose stack — they are backend-
and environment-agnostic. Port-forward or use in-cluster curl.

```bash
# 1. Backends ready (Mimir port: 9009 monolith / 8080 distributed chart)
for svc in loki:3100 tempo:3200 mimir:9009; do
  kubectl -n observability run curl --rm -it --image=curlimages/curl -- \
    curl -s http://${svc%%:*}.observability.svc:${svc##*:}/ready ; done   # expect "ready"

# 2. Cardinality limit actually enforced (an unverified limit is not a limit):
#    push a 40-label metric via OTLP and confirm Mimir returns
#    err-mimir-max-label-names-per-series and stores nothing.

# 3. Correlation round-trip (the real acceptance test):
#    generate traffic → find a trace in Tempo → its logs in Loki via
#    `{service_name="..."} | trace_id=~`0*<id>`` → the log's trace_id resolves
#    back in Tempo. Both directions = correlation works.

# 4. Exemplar link: query a latency metric with exemplars enabled; a data
#    point's traceID must resolve to a real trace in Tempo.
```

See [`GUIDE.md`](./GUIDE.md) → "Answering what's impacted?" for the exact
queries; they are unchanged on Kubernetes.

---

## Recommended rollout path

Don't jump straight to distributed-everything. Prove correlation first, then
scale the storage layer.

1. **Pilot** — single-binary Loki/Tempo, monolithic Mimir, a PVC each; gateway
   collector (1–2 replicas) + infra scraper (1 replica); Grafana with the
   ConfigMap datasources. Run the four verification checks. This proves the
   *wiring* — the part most likely to be subtly wrong.
2. **Storage** — move each backend to object storage; set real retention; take a
   backup. Re-run verification.
3. **Scale** — switch Loki to SimpleScalable/Distributed, Mimir to distributed
   ingesters, add HPAs. Re-run verification after each.
4. **Harden** — TLS, Grafana OIDC, NetworkPolicies, multi-tenancy, alert rules
   (Mimir's ruler is available; the dev stack ships none).

---

## What this guide does not cover

- Complete, tested manifests — by design (see the banner). Adapt and verify.
- GitOps/ArgoCD/Flux packaging, cluster autoscaling, cost controls.
- Sampling (head/tail) — recommended at scale; the dev stack samples nothing.
- The apps' own infra (Redis/Postgres/RabbitMQ) lifecycle — use operators or
  managed services; this guide only covers the collector *reaching* them.
- Keycloak (Phase 4 in the project plan) — deferred; when it lands it also
  becomes Grafana's OIDC provider.

For the design rationale behind any setting referenced here, see
[`CLAUDE.md`](./CLAUDE.md); for using the stack once deployed, see
[`GUIDE.md`](./GUIDE.md).
