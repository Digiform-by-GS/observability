---
name: dashboards
description: Provision a Grafana service-overview dashboard (request rate, errors, latency, span-name cardinality, logs) for a service onboarded to the Digiform observability platform. Use when the user wants a dashboard for their service or asks where to see their service's metrics and logs.
---

# Provision a service dashboard

Creates a per-service overview dashboard in the platform's Grafana from
[assets/service-dashboard.json](assets/service-dashboard.json). The platform
also has shared dashboards; this one gives a team a focused, service-scoped
starting point they own.

## What the template shows (and why these panels)

| Panel | Query basis | Why |
|---|---|---|
| Request rate by operation | `traces_spanmetrics_calls_total` | RED metrics derived from spans — exist automatically, no app-side metric code |
| Error rate | same, `status_code="STATUS_CODE_ERROR"` | Span status drives this; it's the alerting-grade signal |
| p95 latency by operation | `traces_spanmetrics_latency_bucket` | Histogram per span name, from the platform's generator |
| Span-name cardinality | `count(sum by (span_name)(...))` | **Should stay flat.** A climbing line means raw paths are leaking into span names — the exact failure that eventually gets a team's metric writes rejected |
| Logs | `{service_name="$service"}` | Trace-correlated; each row links to its trace |

Two label systems, both used above — do not "fix" the inconsistency:
span-derived metrics label the service **`service`**; logs and app-emitted
metrics label it **`service_name`**. Both are correct in their own system.

## Steps

1. Read `.observability/platform.json` for the Grafana URL (if missing, run the
   onboard skill's Step 0 first). Get the service name from the repo's
   `OTEL_SERVICE_NAME` (env files, start scripts) — ask only if ambiguous.
2. Load the template, replace every `__SERVICE__` with the service name.
   The result has uid `svc-<name>`, so re-provisioning updates in place
   rather than duplicating.
3. Creating dashboards needs **Editor** rights — anonymous platform access is
   view-only. Ask the user for a Grafana service-account token (their platform
   operator issues these per team; read it from `GRAFANA_SA_TOKEN` in the
   environment, never write it to a file), then:

   ```
   POST {grafana}/api/dashboards/db
   Authorization: Bearer $GRAFANA_SA_TOKEN
   Content-Type: application/json

   { "dashboard": <the filled template>, "overwrite": true,
     "message": "provisioned by observability-onboard plugin" }
   ```

   A 200 response carries the dashboard `url` — give the user the full link
   (`{grafana}` + `url`).
4. **No token available?** Don't block onboarding on it. Fall back: save the
   filled template as `<service>-dashboard.json` in the repo and tell the user
   to import it via Grafana → Dashboards → New → Import. The dashboard is a
   convenience; the telemetry is already flowing.

## After provisioning

Sanity-check by opening the dashboard with recent traffic (or after running the
verify skill, whose Stage B traffic populates every panel). Empty panels with
a running service usually mean no traffic since the platform last restarted —
span-derived series need fresh requests to appear, typically within ~30s.
