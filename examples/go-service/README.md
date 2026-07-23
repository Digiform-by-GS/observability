# go-service — Go example

The Go counterpart of [`examples/nodejs-sample`](../nodejs-sample/), wired to
[`observability-go`](../../packages/observability-go/). It exists to prove the
correlation round trip end to end.

Runs **containerised on the `obs` network** rather than on the host, so it
reaches the collector by DNS name (`http://otel-collector:4318`) — the same way
the Redis and RabbitMQ receivers will reach their targets in later phases.

## Run

```bash
docker compose build go-service && docker compose up -d go-service
curl localhost:8090/healthy
```

Or on the host, against the published collector port:

```bash
OTEL_SERVICE_NAME=go-service OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  PORT=8090 go run .
```

## Endpoints

| Route | Behaviour |
|---|---|
| `/healthy` | 200 |
| `/slow` | sleeps 200–500ms, logs with context |
| `/error` | 500 + an error-level log |
| `/work` | custom span + **instrumented self-call** |
| `/cache` | Redis `INCR` + `EXPIRE` — nested client spans |
| `/widgets` | one Postgres query |
| `/widgets/slow?n=12` | **deliberate N+1** — see below |
| `POST /publish` | publish an order to RabbitMQ; `?fail=1` dead-letters it |

### RabbitMQ — publish→consume with span links

`POST /publish` sends an order to the `orders` queue; a background consumer processes it. **They are
two separate traces joined by a link**, not one parent-child trace — see
[`observability-go/amqp`](../../packages/observability-go/amqp/) for why (queued messages would
otherwise make multi-hour traces, fan-out would branch endlessly, and consumes past Tempo's retention
would dangle).

To see it: publish a few, then in **Explore → Tempo** open an `orders process` trace — its consumer
span carries a link back to the `POST /publish` trace. `?fail=1` makes the handler error, the message
nacks to `orders.dlq`, and the dead-letter log records the origin trace id.

Because they are separate traces, **the `orders` flow does not appear as a service-graph edge** — that
is correct. Query the async flow from span-metrics instead:

```promql
sum by (span_kind, messaging_destination_name) (
  traces_spanmetrics_calls_total{span_kind=~"SPAN_KIND_PRODUCER|SPAN_KIND_CONSUMER"}
)
```

`messaging_message_age_seconds` (publish→consume latency) is the metric queue depth cannot give you:
depth says there's a backlog, age says how stale the data your consumers are acting on is.

`/cache` and `/widgets*` report themselves disabled (503) if `REDIS_ADDR` / `POSTGRES_DSN` are
unset; the service still boots. A demo that refuses to start without its cache teaches the wrong
lesson about coupling.

### `/widgets/slow` — why client spans matter

It issues one query per row plus a Redis GET each, producing **~40 spans in a single request**:

```
/widgets/slow
├── sql.conn.query   × 12
├── sql.rows         × 12
├── sql.conn.reset_session × 12
└── get              × 3
```

While it runs, the `redis` and `postgresql` receivers report **perfect health** — from the server's
point of view these are fast, correct commands. Only the client spans attribute the work back to the
request that caused it. That is why both halves are instrumented.

`/work` is the one that matters: it makes an outbound HTTP call back to
`/healthy`, so the trace must nest as

```
/work  →  downstream-fetch  →  HTTP GET  →  /healthy
```

If those appear as two separate traces, the global propagator is not set (see
`observability-go`'s `New`) or the client transport is not wrapped. That is the
same defect that will break RabbitMQ context propagation later, so fix it here.

## Acceptance test

```bash
# 1. generate traffic
for i in $(seq 1 10); do curl -s -o /dev/null localhost:8090/work; done

# 2. find a trace
curl -sG localhost:3200/api/search \
  --data-urlencode 'q={ resource.service.name = "go-service" }' \
  --data-urlencode "start=$(($(date +%s)-300))" --data-urlencode "end=$(date +%s)"

# 3. that trace's logs, across every service it touched
#    NB: 0* — Tempo strips leading zeros from trace ids, Loki stores all 32 chars
{service_name="go-service"} | trace_id=~`0*<trace-id>`
```

In Grafana: **Explore → Tempo**, open a trace, click **Logs for this span**;
then on any log line click **View Trace** to come back. Both directions working
is the acceptance criterion for the whole module.

## Notes

- The image is distroless and ~28 MB; the build context is the **repo root**,
  because the service resolves `observability-go` through a `replace` directive.
- Boot is ~1s, versus ~175s for the Node examples on `/mnt/d` — a compiled binary
  does not walk `node_modules` over the WSL2 9P bridge.
