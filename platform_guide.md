# Shared Observability Platform

The LGTM stack running as a shared service at **20.20.1.88**, so application teams
do not each run their own copy. Developers install the library, set two environment
variables, and their telemetry appears in Grafana.

For the full library API and the complete environment-variable contract, see
[developer_guide.md](developer_guide.md). This document covers only what is
specific to the shared deployment.

---

## Endpoints

| What | URL | Who uses it |
|---|---|---|
| OTLP ingest (HTTP) | `http://20.20.1.88:4318` | every app — traces, metrics, logs |
| OTLP ingest (gRPC) | `http://20.20.1.88:4317` | apps preferring gRPC |
| OTLP ingest (browser) | `http://20.20.1.88:4319` | browser/RUM code — origin-allowlisted |
| Grafana | `http://20.20.1.88:3000` | humans |
| Pyroscope | `http://20.20.1.88:4040` | apps that opt into profiling |

Loki, Tempo and Mimir have **no host ports**. They are reachable only on the
internal `obs` Docker network, because their APIs are unauthenticated and
publishing them would let anything on the LAN write straight into a backend,
bypassing every guardrail the collector applies. Query them through Grafana.

---

## Browser (RUM) ingest — port 4319

Browser telemetry uses a **separate receiver on 4319**, not the 4318 every
service uses. Two reasons, both structural:

- Only 4319 sends **CORS** headers. A browser will not post to an endpoint that
  does not, and the failure is a preflight rejection the application cannot see.
- Browser signals get their own pipeline, so their metric labels can be pruned
  without touching service telemetry (see below).

### Adding an origin is a deliberate operation

The allowlist in `infra/otel-collector/config.platform.yaml` is seeded with
localhost only, so a new app **fails closed**. To onboard one:

```bash
# add the app's origin under receivers.otlp/browser...cors.allowed_origins
docker compose restart otel-collector
curl -i -X OPTIONS http://20.20.1.88:4319/v1/traces \
  -H 'Origin: http://the-app.internal' \
  -H 'Access-Control-Request-Method: POST'
# must echo back Access-Control-Allow-Origin; a disallowed origin must NOT
```

Be clear about what this control is and is not. It stops a *browser* on an
unlisted origin from posting. It stops nothing else: CORS binds browsers only,
so anything that can route to the host can write to 4319, and an API key would
not help because anything shipped in a JS bundle is readable by anyone who
opens devtools. **Keep this host off the public internet** until real ingest
authentication exists.

### Why browser metric labels are pruned

`resource/prune-browser-labels` drops `user_agent.original`, `session.id`,
`browser.brands`, `browser.mobile`, and `url.full` from browser **metrics**
only. The exporter promotes every resource attribute to a Prometheus label, and
those attributes vary per *user* rather than per service: `user_agent.original`
is one distinct value per browser build, and `session.id` is unbounded by
definition. Either can multiply the browser metric set by thousands.

Mimir's `max_global_series_per_user` is **global** on this single-tenant
deployment, so exceeding it rejects metric writes for **every service on the
platform**, not only the frontend that caused it. Traces and logs keep all of
these attributes — that detail is exactly what you want when debugging one
user's session, and neither Tempo nor Loki indexes it the way Mimir does.

Watch `sum(cortex_ingester_memory_series)` after onboarding the first browser
app; the existing alert fires at 70% of the cap.

## Onboarding a service

Nothing to install on the platform side. Set the environment variables and start
your app.

**Node**

```bash
export OTEL_SERVICE_NAME=orders                             # required
export OTEL_EXPORTER_OTLP_ENDPOINT=http://20.20.1.88:4318   # the shared platform
export OTEL_RESOURCE_ATTRIBUTES=team=payments               # optional, recommended
```

**Go** — identical; the module shares the env-var contract.

`OTEL_SERVICE_NAME` is the only mandatory one, and it is what every dashboard,
log query and service-graph node is keyed on. Pick the name once and keep it
stable — renaming it later splits your history into two unrelated services.

Add `OTEL_RESOURCE_ATTRIBUTES=team=<yours>` so telemetry can be attributed when
several teams share the platform.

Profiling is opt-in and bypasses the collector entirely (OTLP profiling is still
experimental, so the SDK pushes directly):

```bash
export PYROSCOPE_SERVER_ADDRESS=http://20.20.1.88:4040
```

---

## Rules that protect everyone else

A shared platform fails differently from a laptop stack: one service's mistake
degrades every other team. Two rules matter.

**1. Use the framework wrapper, never bare `otelhttp`, on servers.**

Use `otelchi` / `otelgin` / `otelecho`. They name spans after the route
*template* (`GET /orders/{id}`). Bare `otelhttp` names them after the raw path,
so `GET /orders/1`, `GET /orders/2` … each become a distinct span name — and
Tempo's generator turns every span name into a full latency histogram. Series
count is dominated by span names, not by traffic volume: this is what fills
Mimir, and when Mimir starts rejecting writes it rejects them for everybody.

**2. Keep metric labels bounded.**

The collector prunes the worst automatically — `service.instance.id`,
`process.pid`, `container.id` and friends are dropped from metrics before they
reach Mimir (they survive on traces and logs, where they are useful and cheap).
`service.instance.id` in particular is regenerated by the SDK on every process
start, so without pruning each restart would mint a fresh copy of your entire
metric set. Do not add unbounded values — user IDs, order IDs, raw URLs — as
metric attributes. They belong on spans.

Mimir is capped at 150,000 active series across the whole platform and rejects
writes past that with a visible 4xx rather than dying quietly.

---

## Operator runbook

Everything runs from `/opt/observability` on the VM.

```bash
cd /opt/observability
C="docker compose -f docker-compose.yml -f docker-compose.platform.yml"

$C ps                       # status
$C up -d                    # start / apply config changes
$C logs -f otel-collector   # first place to look when signals go missing
$C restart otel-collector   # configs are bind-mounted; no rebuild needed
$C pull && $C up -d         # upgrade after changing an image tag
```

The overlay makes the demo fixtures (redis, postgres, rabbitmq, go-service)
opt-in via the `demo` profile, so a plain `up -d` starts only the six platform
services. Add `--profile demo` if you ever want the examples on this host.

Secrets live in `/opt/observability/.env` (gitignored — this repository is
public). Compose refuses to start if `GRAFANA_ADMIN_PASSWORD` is unset, so the
platform cannot accidentally be deployed with a default password.

### Grafana access

Anonymous visitors get **Viewer**, which keeps dashboards zero-friction for
developers while removing the ability to edit datasources or delete dashboards.
Admin actions require the login in `.env`. To require a login for viewing too,
set `GRAFANA_ANONYMOUS=false` and re-run `up -d`.

### Host requirements

- **CPU must support x86-64-v2.** Tempo and Pyroscope ship `GOAMD64=v2` binaries
  and abort at startup on CPU models that mask SSE3/SSSE3/SSE4.x/POPCNT/
  CMPXCHG16B — notably KVM's default `kvm64` model, which reports itself as
  "Common KVM processor". Grafana, Loki, Mimir and the Collector are baseline
  builds and run fine, so the failure looks like "two services are broken"
  rather than a host problem. Set the guest CPU model to `host-passthrough`
  (or any `x86-64-v2`-capable model).
- **8 GB RAM minimum.** Platform `mem_limit`s total 5.25 GB, with Mimir taking
  2 GB so that its 150k-series cap is backed by real memory rather than losing
  the race to the OOM killer.
