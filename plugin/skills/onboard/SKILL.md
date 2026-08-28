---
name: onboard
description: Instrument this repository's service(s) against the Digiform observability platform — traces, metrics, and trace-correlated logs over OTLP. Use when the user wants to onboard a service, add observability/telemetry/tracing, or connect to the observability platform. Handles Node.js (Express/Fastify/plain) and Go (chi/gin/echo/gorilla); Next.js and browser/RUM get their own paths.
---

# Onboard a service onto the observability platform

You are instrumenting the user's service so that traces, metrics, and
trace-correlated logs flow to a central observability platform (OTel Collector →
Grafana stack). The libraries do the heavy lifting; your job is wiring them in
correctly and not falling into the traps listed here. Every trap in this skill
was hit for real during the platform's development — none are hypothetical.

## Versions come from `compat.json` — never guess one

Read [references/compat.json](references/compat.json) **before installing
anything**, and copy its `install` strings verbatim. It pins every package this
skill adds, for every stack.

Do not infer a version from the repo you are onboarding, from a registry's
`latest`, or from memory. Both defects this onboarding has shipped to a real
client were versions chosen where nothing authoritative said otherwise: a
two-major-stale `@vercel/otel` that could not resolve against the platform's
OpenTelemetry set, and a `package.json` edit with no lockfile that broke the
client's `npm ci` outright. You cannot tell a current version from a stale one by
looking at it, so do not try.

`compat.json` also carries the **lockfile rule**, which is not optional: a
dependency change without its lockfile is a broken patch, not an incomplete one.
Regenerate it (`npm install --package-lock-only --ignore-scripts`, or
`go mod tidy`) and include it.

## Step 0 — Platform endpoints (`.observability/platform.json`)

Check for `.observability/platform.json` in the repo root. If present, use it and
skip to Step 1. If absent, ask the user for their platform endpoints (their
platform operator publishes these; do not guess), then create it:

```json
{
  "otlp_http": "http://<platform-host>:4318",
  "otlp_browser": "http://<platform-host>:4319",
  "grafana": "http://<platform-host>:3000",
  "pyroscope": "http://<platform-host>:4040"
}
```

`otlp_browser` is a **different port from `otlp_http`, not a typo**: it is the
only receiver with CORS, which is what lets a browser post to it at all. Omit
the key if the platform does not publish one — then browser telemetry is not
available and you should say so rather than pointing browser code at
`otlp_http`, where every export dies at the preflight.

Commit this file — it contains no secrets, and it is how every other skill in
this plugin (verify, dashboards) finds the platform without asking again. If the
file later gains a `tenant` field and an API-key reference, newer platform
versions use those; never write an actual key into this file — keys live in env
vars or `.env` (gitignored).

## Step 1 — Detect the stack

- `package.json` present → Node path. Check `dependencies` for `express`,
  `fastify`, `next`. **If `next` is present → use the Next.js path in
  [references/node.md](references/node.md) — the standard wrapper does not work
  in Next.js and one wouldn't help.**
- A **frontend** (`react`, `vue`, `svelte`, `next`, `vite`, or an `index.html`
  entry) → it also has a browser half. Server-side instrumentation says nothing
  about what the user experienced, which matters most when the browser calls an
  API directly rather than through the app's own server. See
  [references/browser.md](references/browser.md). This is an ADDITION to the
  server-side path, not a replacement — a Next.js app wants both.
  **Check first that the platform publishes a browser OTLP endpoint**; without
  one, browser telemetry cannot be delivered at all and you should onboard the
  server side only and say so.
- `go.mod` present → Go path. Check imports for `go-chi/chi`, `gin-gonic/gin`,
  `labstack/echo`, `gorilla/mux`. Also note `redis`, `pgx`/`database/sql`,
  `amqp091` — each has a dedicated helper. Watch for WebSocket routes,
  scheduled jobs, and HTTP clients that build their own transport; all three
  need explicit handling covered in [references/go.md](references/go.md).
- Both present (monorepo) → ask which service(s) to onboard, or onboard each
  detected service one at a time.

Read the matching reference before editing anything:
- Node / Next.js: [references/node.md](references/node.md)
- Go: [references/go.md](references/go.md)
- Browser / RUM: [references/browser.md](references/browser.md)

## Step 2 — Environment variables (the shared contract, both stacks)

Only one variable is mandatory:

| Variable | Required | Value |
|---|---|---|
| `OTEL_SERVICE_NAME` | **Yes** | Logical service name — see rules below |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Recommended | `otlp_http` from platform.json |
| `OTEL_RESOURCE_ATTRIBUTES` | Recommended | `team=<the user's team>` |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | Optional | `development` / `staging` / `production` |
| `OTEL_SERVICE_VERSION` | Optional | Release tag like `1.4.2` — **never a git SHA** (each distinct value mints a full new set of metric series) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Only if the platform requires auth | `Authorization=Bearer <key>` — the operator issues the key; keep it in `.env`/secrets, never in platform.json |

Wire these wherever the service already gets its env (`.env` file, compose
`environment:`, deployment manifest). Follow the repo's existing convention.

**`OTEL_SERVICE_NAME` rules** (it is the identity of everything this service
emits — every dashboard, log query, and trace search keys on it):
- One stable value per logical service: `orders`, `checkout-api`.
- Warn the user explicitly: **renaming it later splits their history into two
  unrelated services.** Pick once.
- Never a pod name, instance id, or anything per-deployment.

**`OTEL_RESOURCE_ATTRIBUTES=team=<x>`** matters on a shared platform: it is how
telemetry gets attributed when several teams share the backend. Ask for the
team name; don't invent one.

If the endpoint is unset the libraries default to `http://localhost:4318` —
correct on a laptop running the local stack, **silently wrong** everywhere else:
telemetry goes nowhere and *nothing errors*. Always set it explicitly from
platform.json.

## Step 3 — Instrument (see the per-stack reference for exact edits)

The one-paragraph version:

- **Node**: `npm install @digiform-by-gs/observability`, then add
  `--import @digiform-by-gs/observability/preload` to the start command. Zero code
  changes required; optionally swap the logger for `getLogger()`. Do **not**
  also call `initObservability()` — the preload already did.
- **Go**: `go get github.com/Digiform-by-GS/observability/packages/observability-go`,
  ~8 lines in `main()` (init + deferred shutdown), one middleware line on the
  router, switch log calls to the `...Context(ctx, ...)` variants.

## Step 4 — Verify

After the edits, run the **verify** skill (same plugin). Do not declare
onboarding done because the app starts — an app with a typo'd endpoint starts
fine and sends everything into the void. Verification means the signals were
read back out of the platform.

## The traps (why the reference docs say what they say)

You will be tempted to deviate from the references when the user's codebase
looks unusual. These rules survive deviation only if you understand them:

1. **Init order is everything (Node).** OTel instruments libraries *at import
   time*. Any module imported before the SDK starts is invisible to tracing —
   no error, just missing spans. That is why the preload flag is the default
   path and inline `initObservability()` is the fragile fallback.

2. **Span names must be route templates, never raw paths (both stacks).** The
   platform generates rate/error/latency metric series *per span name*. A
   framework middleware names spans `GET /orders/{id}` — one series set. Bare
   `otelhttp` (Go) names them after the concrete path — `GET /orders/1`,
   `GET /orders/2`, … an unbounded series explosion that eventually gets the
   whole platform's metric writes rejected, not just this service's. If the
   user's framework has no listed middleware, find its OTel contrib middleware
   (route-template naming is the acceptance criterion), or fall back to
   `otelhttp` **with a route-template span-name formatter** — never with
   defaults.

3. **Only context-carrying log calls correlate (Go).** `logger.Info(...)`
   compiles, runs, errors nothing — and produces a log that can never be joined
   to its trace. Only `logger.InfoContext(ctx, ...)` carries the span. Fix every
   call site you touch and recommend the `sloglint` linter (config in the Go
   reference) so CI catches the ones you didn't.

4. **`ctx` is the trace (Go).** Break the `context.Context` chain anywhere in
   the call path and everything below it logs and spans into the void. When
   refactoring user code, thread `ctx` through; never stash a
   `context.Background()` in the middle of a request path.

5. **Metric labels and resource attributes must be low-cardinality (both).**
   Every distinct value of a metric attribute or resource attribute becomes a
   new time series on the shared platform, which enforces a hard series cap.
   IDs belong in span attributes and log fields — never in metric attributes,
   span names, or `OTEL_RESOURCE_ATTRIBUTES`/`OTEL_SERVICE_VERSION` values that
   change per deploy.

## Done looks like

- Dependency added, start command / main() wired per the reference.
- Env vars set with a stable `OTEL_SERVICE_NAME` and the platform endpoint.
- `.observability/platform.json` present and committed.
- The verify skill passes: trace, correlated log, and metrics all read back
  from the platform.
- The user knows their Grafana URL and that their service appears under its
  `OTEL_SERVICE_NAME`.
