---
name: verify
description: Prove that a service's telemetry actually arrives in the observability platform — trace, correlated log, and metrics read back out of the backends from the client side. Use after onboarding a service, when signals seem missing, or when the user asks "is my observability working".
---

# Verify signals end-to-end

"The app starts" is not evidence. A service with a typo'd endpoint starts
cleanly and sends every signal into the void, erroring nowhere. Verification
means: push telemetry in, **read it back out of the platform's backends**, and
check the properties that make it useful (correlation, bounded cardinality).

## How read-back works

Read `.observability/platform.json` (if missing, run the onboard skill's Step 0
first). The platform's storage backends are deliberately not exposed —
**all read-back goes through Grafana's datasource proxy**, which works for
anonymous viewers on the pilot platform:

```
{grafana}/api/datasources/proxy/uid/tempo/api/traces/<trace-id>
{grafana}/api/datasources/proxy/uid/loki/loki/api/v1/query_range?query=...&start=...
{grafana}/api/datasources/proxy/uid/prometheus/api/v1/query?query=...
```

If these return 401/403, the platform requires login: ask the user for a
Grafana service-account token (their platform operator issues them) and send it
as `Authorization: Bearer $GRAFANA_SA_TOKEN` on the proxy calls. Read the token
from the environment; never write it to a file.

**Two label systems — easy to mix up, queries silently return nothing:**
- Metrics generated from spans (`traces_spanmetrics_*`) label the service
  **`service`**.
- Logs label it **`service_name`**.
- App-emitted metrics carry **`service_name`** (promoted from the resource).

## Stage A — synthetic round-trip (proves the pipeline from this machine)

Run [scripts/verify-signals.sh](scripts/verify-signals.sh) if bash is
available; on Windows or where it isn't, perform the same steps natively (the
script is the reference — read it, then use your HTTP tool of choice). Steps:

1. Generate a random 32-hex-char trace id (**first char non-zero** — the trace
   store strips leading zeros from ids, which breaks naive string matching
   ~1 time in 16) and a 16-hex-char span id.
2. POST one span, one log (carrying the same trace/span ids), and one counter
   metric to `{otlp_http}/v1/traces|logs|metrics` as OTLP JSON, under a
   throwaway service name like `verify-<user>-<date>`.
3. Wait ~20s (batching + ingest).
4. Read back through the Grafana proxy:
   - **Trace**: `GET .../uid/tempo/api/traces/<trace-id>` → 200 and the body
     contains your service name. Note: the response encodes span ids as
     **base64 of the raw bytes**, not hex — don't grep for the hex form.
   - **Log**: query `{service_name="<name>"}` → your log line present.
   - **Correlation**: query ``{service_name="<name>"} | trace_id=~`0*<trace-id>` ``
     → still returns the line. The `0*` prefix absorbs the stripped-zeros
     mismatch. `trace_id` is queryable metadata, **not** body text — if the
     plain query works but this one doesn't, correlation is broken.
   - **Metric**: instant-query the counter (a monotonic sum arrives with a
     `_total` suffix appended — query `<name>_total`, not `<name>`).

Stage A failing = platform or network problem, not the user's app. Check: can
this machine reach `{otlp_http}` at all? Is the collector up (platform
operator's side)? Report which signal failed and where it stopped.

## Stage B — the real service (proves the integration)

1. Start the user's service with its real env (`OTEL_SERVICE_NAME=<svc>` etc.).
2. Exercise one or two HTTP endpoints (or one message consume for workers).
3. Wait ~20s, then check via the proxy:

| Check | Query | Pass condition |
|---|---|---|
| Trace arrived | Loki-side shortcut: find a `trace_id` in the service's logs, then fetch it from Tempo; or search `.../uid/tempo/api/search?q=` with `{resource.service.name="<svc>"}` | The exercised request's trace exists with the HTTP span |
| Logs correlated | ``{service_name="<svc>"} | trace_id=~`.+` `` | Request-path logs carry a trace_id (app logs emitted outside requests legitimately have none) |
| Metrics flowing | `traces_spanmetrics_calls_total{service="<svc>"}` | Non-empty |
| **Span names bounded** | `count(sum by (span_name) (traces_spanmetrics_calls_total{service="<svc>"}))` and list the names | Names are route **templates** (`GET /orders/{id}`). FAIL if names contain concrete ids/numbers (`GET /orders/42`) — see below |
| Runtime metrics | Node: `nodejs_eventloop_utilization` / Go: `process_runtime_go_goroutines` filtered on `service_name="<svc>"` | Present (confirms SDK metrics beyond spans) |

**Span-name check is a hard gate, not advice.** Concrete paths in span names
mean the platform mints a full rate/error/latency series set per distinct URL —
on a shared platform this eventually gets metric writes rejected for *every*
team. If you see raw paths: the service is using a non-templating handler
wrapper (in Go, typically bare `otelhttp`) — go back to the onboard skill's
router-middleware section and fix it before declaring victory.

## Troubleshooting table

| Symptom | Likely cause | Fix |
|---|---|---|
| Nothing arrives at all | Endpoint unset → defaulting to `localhost:4318`; or wrong port; or firewall | Set `OTEL_EXPORTER_OTLP_ENDPOINT` from platform.json; `curl {otlp_http}/v1/traces` expects HTTP 405 on GET (proves reachability) |
| Traces yes, logs missing trace_id (Node) | Preload flag missing, or a worker-thread log transport was added | Restore `--import @digiform/observability/preload`; remove pino transports |
| Traces yes, logs missing trace_id (Go) | `logger.Info` instead of `InfoContext(ctx, ...)` | Convert call sites; add sloglint |
| Each service traces alone, nothing joins (Go) | Global propagator not set (a raw OTel setup, or init happens after first request) | Ensure `observability.New()` runs in `main` before serving |
| Every OTLP export 404s (custom Go setup) | Exporter configured with endpoint+path so the SDK appends the path twice (`/v1/traces/v1/traces`) | Use the library defaults; endpoint is the *base* URL |
| Metric query empty but you saw it sent | Counter queried without `_total`; or wrong label (`service` vs `service_name`) | See the label-systems note above |
| Trace found in UI but Loki `trace_id=` match fails | Leading zeros stripped from the id | Match with ``trace_id=~`0*<id>` `` |
| Proxy calls return 401/403 | Platform requires login | `Authorization: Bearer $GRAFANA_SA_TOKEN` |

## Report format

End with a table of the checks, PASS/FAIL each, and for failures: the exact
query used, the response, and the single most likely cause from the table
above. Onboarding is complete only when Stage B is all-PASS.
