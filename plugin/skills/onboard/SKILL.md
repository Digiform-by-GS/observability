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

## Step 0b — The four things you cannot read (`.observability/service.json`)

If `.observability/service.json` exists, **use it and skip this step** — and
where it disagrees with anything you were told in the task, the file wins. It
was committed by someone looking at their own infrastructure; a parameter was
typed into a form by someone who may not have been.

If it is absent, ask these four questions, then write the file. Ask only these:
everything else about the service you can determine by reading the repository,
and questions with knowable answers train people to click past the ones that
matter.

1. **Where does this service get its environment variables in the environment
   you are onboarding?** In this repository, another repository (GitOps/Helm),
   a secret manager, or you are not sure. **If it is not this repository, ask
   where** — the repo, file and key. This single string is what turns "set these
   variables somewhere" into an instruction someone can act on.
2. **Which environment does this branch deploy to?** `development`, `staging`,
   or `production`. Branch-to-environment mappings are conventions, not
   something a repository states.
3. **Do you want correlated logs?** This changes their log format (see Step 3b),
   so it is genuinely their call, not a default you can assume.
4. **Do you want browser/RUM?** Only meaningful if the service serves a UI, and
   only possible if the platform publishes `otlp_browser`. If yes, ask for the
   **deployed public URL** — the platform operator needs that origin for the
   collector's CORS allowlist, which is not something you can do from here.

```json
{
  "deployment_config": "other_repo",
  "deployment_config_location": "infra-config.git → charts/orders/values-dev.yaml, key secretEnv",
  "environment": "development",
  "signals": ["traces", "metrics", "logs"],
  "app_url": "https://app.example.com"
}
```

`deployment_config` is one of `in_repo`, `other_repo`, `secret_manager`,
`unknown`. Traces and metrics are always both present or both absent — they come
from one SDK init, so there is no such thing as one without the other.

**Warn before writing `deployment_config_location`:** this file is committed to
their repository, so an internal repo name or a secret-manager path goes into
their history. If that is sensitive, leave it out and keep the handoff generic.

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

## Step 1b — Is it ALREADY onboarded? Check before changing anything

Grep before you edit:

```
observability.New(        initObservability(
registerOTel(             initBrowserObservability(
```

If any of these exist, this is **not a fresh onboarding**. The service already
reports, and your job changes completely: find what is MISSING, do not re-apply
the parameters you were handed.

**The files under `.observability/` are not evidence on their own.** When this
skill runs unattended, the harness *seeds* `platform.json` and `service.json`
before you start, so their presence says nothing about the service. What counts
is whether they predate this run:

```
git log --oneline -1 -- .observability/platform.json
```

Output means a human committed it and the service is very likely onboarded
already. No output means it arrived with this run — ignore it and judge by the
code markers above.

### Never change an existing OTEL_SERVICE_NAME. Not ever.

This is the one rule in this skill with no exceptions.

The service name is the identity of everything the service has ever emitted.
Renaming it does not relabel history — it **splits it into two unrelated
services**: every existing trace, metric and log stays under the old name, the
dashboards go quiet, and the alerts that watched it never fire again. Nothing
errors. It looks like the service stopped existing.

So if the name you were given differs from the one already in the repository:

- **Keep the repository's name.** It is the source of truth, not the form.
- Say so plainly in your summary: "this service already reports as `<existing>`;
  I did not rename it to `<requested>`, because renaming splits its history."
- Change nothing else about it.

This has already gone wrong in production here. An operator typed the wrong name
into a form, the agent dutifully rewrote `WithServiceName("costwise-backend")`
to `WithServiceName("frontend")` across four files, and opened a merge request
proposing to orphan a live service's entire history. Note also that in the Go
and Node wrappers the **code option beats the environment variable**, so an
in-code rename silently overrides whatever the deployment sets.

### What to do instead: report the gaps

Work through what is present and what is not, then act only on the gaps:

| Check | If missing |
|---|---|
| Logs reaching the platform | Usually the access logger — see Step 3b |
| `OTEL_DEPLOYMENT_ENVIRONMENT` set per deployment | See Step 2 |
| Router middleware naming spans by route template | See the per-stack reference |
| Outbound HTTP propagating `traceparent` | See the per-stack reference |
| Browser/RUM, if it serves a UI | See references/browser.md |

If everything is already in place, **report `no_changes` and say what you
checked**. "Already onboarded, here is what I verified, here is the one gap I
found" is a genuinely useful result. Inventing a diff to look productive is not —
and a rename is the most damaging way to do it.

## Step 2 — Environment variables (the shared contract, both stacks)

Only one variable is mandatory:

| Variable | Required | Value |
|---|---|---|
| `OTEL_SERVICE_NAME` | **Yes** | Logical service name — see rules below |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Recommended | `otlp_http` from platform.json |
| `OTEL_RESOURCE_ATTRIBUTES` | Recommended | `team=<the user's team>` |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | **Yes, and different per deployment** | `development` / `staging` / `production` — see the promotion warning below |
| `OTEL_SERVICE_VERSION` | Optional | Release tag like `1.4.2` — **never a git SHA** (each distinct value mints a full new set of metric series) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Only if the platform requires auth | `Authorization=Bearer <key>` — the operator issues the key; keep it in `.env`/secrets, never in platform.json |

### Where to put them — by file class, not by "what the repo seems to do"

"Follow the repo's existing convention" is what this skill used to say, and it
is how the worst onboarding defect so far happened: a repo contained
`deployment/{development,staging}/deployment.yaml` and another contained
`.helm/values-*.yaml`, the agent dutifully added the variables to both, and
**every one of those files was dead**. The live configuration was in a different
repository entirely (`Vault → Helm values repo → ArgoCD`), which is invisible
from inside the clone. The merge requests looked like success and changed
nothing.

So the rule is about the *class of file*, which you can see, not about which
config is live, which you usually cannot:

**Always safe to edit** — the repository's own runtime, no shadow copy exists:

- `.env.example` (documentation; never `.env` itself, which is gitignored)
- `docker-compose.yml` → `environment:`
- `package.json` scripts, `Procfile`

**Never edit unless the user has explicitly told you the deployment config for
this environment lives in this repository:**

- Kubernetes manifests (`Deployment`, `ConfigMap`, `StatefulSet`)
- Helm `values*.yaml`, anything under `.helm/` or `charts/`
- ArgoCD `Application` specs, Kustomize overlays

For that second class, **put the variables in the PR body instead**, as a block
whoever owns that configuration can paste. Name the destination if you were told
it; ask for it if you were not. A handoff someone has to act on is worth more
than an edit nobody reads.

### The GitOps smell — detect it yourself

Application code **and** Kubernetes/Helm manifests in the same repository is
evidence that the manifests are a stale copy, because in GitOps the live ones
live in a config repo. It is evidence, not proof — so weigh it, say what you
concluded, and default to the handoff. What strengthens it:

- `argocd.argoproj.io/*` annotations anywhere in the repo
- a `.helm/` or `deployment/` directory that no CI pipeline in the repo publishes
- an image tag pinned to something far older than the latest commit
- several environment directories (`development/`, `staging/`, `production/`)
  whose contents have drifted apart

If you see these, say so in the PR body in as many words: *"this repo contains
deployment manifests, but they appear to be a stale copy — I have not edited
them; here are the variables to set wherever the live config lives."*

**`OTEL_SERVICE_NAME` rules** (it is the identity of everything this service
emits — every dashboard, log query, and trace search keys on it):
- One stable value per logical service: `orders`, `checkout-api`.
- Warn the user explicitly: **renaming it later splits their history into two
  unrelated services.** Pick once.
- Never a pod name, instance id, or anything per-deployment.

**`OTEL_DEPLOYMENT_ENVIRONMENT` is the one value that MUST change on
promotion.** Everything else in this table is the same in every environment;
this one is not, and it is the only variable a deploy can get wrong while
looking completely healthy.

Two ways it goes wrong, neither of which raises an error:

- **Left unset.** The platform's collector stamps its own value on anything that
  does not set one, so every service silently reports the *same* environment.
  The Environment filter in Grafana then shows one value covering everything and
  filtering by it hides nothing — it looks like it works.
- **Not updated on promotion.** Promoting an image from dev to production does
  not carry this value with it. If the production deployment reuses the dev
  configuration, **production reports itself as development**: real user traffic
  lands under a name people treat as safe to ignore, and production looks idle.

This is not hypothetical. On this platform two services in the *same* namespace
currently report different environments — one sets its own, the other inherits
the collector's default — so the dropdown offers two values for one environment
and either choice hides half the stack.

So: **it belongs in the deployment configuration, never in the image.** A
Kubernetes `env:` block, a Helm value, a secret manager entry — whatever the
target already uses for per-environment config. If it is baked in at build time,
one image cannot serve two environments and promotion silently mislabels.

Note what that means alongside the file-class rule above: the one variable that
*most* needs to be set is usually in the one place you are *least* likely to be
allowed to edit. That is not a contradiction to resolve by editing the manifest
anyway — it is the reason the handoff block exists. Put the value in the PR body
with the environment named, and if you were told where the live config lives,
name that too.

**Say this to whoever deploys the change**, in the PR body, in these words or
close to them:

> `OTEL_DEPLOYMENT_ENVIRONMENT` must be set per environment. When promoting this
> to production, update it to `production` — the image is identical, only this
> value differs. If it is missed, production telemetry will be labelled as
> whatever the previous environment was.

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

## Step 3b — Check how the service already logs, and recommend the fix

A service can end up with traces and metrics but **zero logs**, which reads as a
platform fault and is not one. The usual cause is an HTTP access logger writing
to stdout, which the OTLP bridge never sees:

```
gorilla   handlers.LoggingHandler(os.Stdout, ...)
gin       gin.Logger()
chi       middleware.Logger
echo      middleware.Logger()
express   morgan(...)  /  console.log in a middleware
```

Grep for these. If you find one, **do not replace it yourself** — changing a
service's log format is a behaviour change, not instrumentation, and something
may be parsing those lines.

Instead, put a ready-to-paste replacement in the PR body, taken from the
per-stack reference ([go.md](references/go.md), [node.md](references/node.md)),
and say plainly what it buys and what it costs:

> Your access logger writes to stdout, so these lines never reach the platform
> and the service will show traces and metrics but no logs. The snippet below
> replaces it with the correlated logger — same one line per request, plus a
> `trace_id` that joins each line to its trace. It changes your log format, so
> it is your call. Register it after the OTel middleware, and remove the old
> handler or you will get two records per request.

Say so even when you change nothing: "logs are not wired, here is why, here is
the fix" is a useful result. Silence reads as "logging works".

## Step 4 — Verify

After the edits, run the **verify** skill (same plugin). Do not declare
onboarding done because the app starts — an app with a typo'd endpoint starts
fine and sends everything into the void. Verification means the signals were
read back out of the platform.

## Step 5 — State your coverage, signal by signal

Finish by saying explicitly, for each of **traces, metrics, logs, and browser
RUM**, whether it is wired — and if not, why not, citing the file that decides
it. Four lines. Do not skip the ones that went fine.

| State | Means |
|---|---|
| `wired` | The code path is present in your diff |
| `not_wired` | It is not, and the reason says which file shows that |
| `n/a` | The stack cannot carry it (e.g. logs on Next.js) or it was not asked for |

Two things this is not. It is **not** a claim that data arrives — you have not
run the application, and only the verify skill can say that; `wired` means the
code is there and nothing more. And it is **not** a formality: a signal that is
missing is a genuinely useful result, so report it rather than rounding it up.

This exists because Step 3b — "check how the service logs, recommend the fix" —
was already a documented completion criterion and still failed to fire on three
consecutive runs. A step in the middle of a procedure gets skipped once the task
feels done, and nothing downstream could tell "checked, it was fine" apart from
"never looked". A per-signal statement at the end can be checked by someone who
was not there.

When running unattended, the harness will tell you to write this as a JSON file;
follow its instructions for the exact path and shape.

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

- If the service was ALREADY onboarded: its existing `OTEL_SERVICE_NAME` is
  untouched, and the summary says which gaps you found rather than what you
  re-applied.
- Dependency added, start command / main() wired per the reference.
- Env vars set with a stable `OTEL_SERVICE_NAME` and the platform endpoint.
- `OTEL_DEPLOYMENT_ENVIRONMENT` set for this environment — in the deployment
  config if you were told it lives in this repo, otherwise in the PR body's
  handoff block naming where it does live. The PR body tells whoever promotes it
  that this one value must change for production.
- **No Kubernetes manifest, Helm values file or ArgoCD spec was edited** unless
  you were explicitly told the live config is in this repository. If you found
  such files and left them alone, the PR body says so and says why.
- `.observability/platform.json` and `.observability/service.json` present and
  committed.
- Coverage stated for all four signals (Step 5), including the ones that are
  fine and the ones that are `n/a`.
- The verify skill passes: trace, correlated log, and metrics all read back
  from the platform.
- The user knows their Grafana URL and that their service appears under its
  `OTEL_SERVICE_NAME`.
- If the service logs through a framework access logger, the PR body says so and
  carries the replacement snippet. A service with traces and metrics but no logs
  is a half-onboarded service, and the owner should know which half.
