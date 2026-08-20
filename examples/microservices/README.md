# microservices-demo — blast-radius example

Three chained Express services, each instrumented with `@digiform-by-gs/observability`:

```
checkout-api :8080  ──►  orders :8082  ──►  payments :8083
```

`payments` has a runtime fault-injection toggle. Flip it on and the failure ripples
up the chain — this example exists to answer **"something broke; what is impacted?"**

## Run

Each service needs its own terminal (or run them backgrounded):

```bash
npm run -w @digiform-by-gs/microservices-demo start:payments   # :8083
npm run -w @digiform-by-gs/microservices-demo start:orders     # :8082
npm run -w @digiform-by-gs/microservices-demo start:checkout   # :8080
```

Requires the stack up (`docker compose up -d`). Each service sets its own
`OTEL_SERVICE_NAME`, so they appear as three distinct services in Tempo/Grafana.

## Drive it

```bash
# happy path — 200, one trace spanning all three services
curl -s localhost:8080/checkout | jq

# start the incident: payments begins failing
curl -s -XPOST localhost:8083/admin/failure-mode \
  -H 'content-type: application/json' -d '{"enabled":true}'

# now the same call fails — 500 all the way up
curl -s -i localhost:8080/checkout

# end the incident
curl -s -XPOST localhost:8083/admin/failure-mode \
  -H 'content-type: application/json' -d '{"enabled":false}'
```

## Answering "what's impacted?"

### 1. Service graph — which edges are failing (the blast radius)

Grafana → **Explore → prometheus**:

```promql
# failing edges: which caller→callee links are broken
sum by (client, server) (rate(traces_service_graph_request_failed_total[5m]))

# every service currently erroring. NB: Tempo's generator labels this `service`,
# not `service_name`; span_kind filters to inbound requests so client spans
# aren't double-counted.
sum by (service) (
  rate(traces_spanmetrics_calls_total{
    status_code="STATUS_CODE_ERROR", span_kind="SPAN_KIND_SERVER"
  }[5m])
)
```

`payments` is the *cause*; `orders` and `checkout-api` are the *impact*. The
service-graph edges show the propagation path, so you can tell a root cause from
a victim: the cause is the deepest failing node, everything above it is collateral.

Grafana → **Explore → Tempo → Service Graph** tab renders the same thing visually.

### 2. Traces — the exact failure path

Grafana → **Explore → Tempo**, TraceQL:

```traceql
{ status = error }                                  # all failing traces
{ resource.service.name = "checkout-api" && status = error }
{ .http.status_code >= 500 }
```

Open a trace: you see `checkout-api GET /checkout` → `orders POST /orders` →
`payments POST /charge`, with the error originating at the payments span and the
error status propagating up. That single view *is* the blast radius for a request.

### 3. Logs — every service's logs for one failed request

Every log record carries `trace_id` as structured metadata, so one trace id gives
you the logs from all three services:

```logql
{service_name=~"checkout-api|orders|payments"} | trace_id=~`0*<paste-trace-id>`
```

> **Gotcha:** Tempo's search API returns trace ids with **leading zeros stripped**
> (31 chars), but Loki stores the full 32-char id. An exact `trace_id="..."` match
> then silently returns nothing for ~1 trace in 16. Matching `0*<id>` tolerates
> both forms.

Or start from the errors and pivot:

```logql
{service_name=~"checkout-api|orders|payments"} |= "unhandled error"
```

Click **View Trace** on any log line to jump to the trace in Tempo.

### 4. Dashboard

Grafana → **Dashboards → Observability → Blast Radius** — failing edges, error
rate per service, and impacted-service table in one place.

## The point

- **Cause vs. impact**: the service graph distinguishes the failing dependency
  from the services merely carrying its failure upward.
- **One trace id** pivots across all three signals and all three services.
- No app code knows about Loki/Tempo/Mimir — everything above comes from the
  same OTLP pipeline the wrapper sets up.
