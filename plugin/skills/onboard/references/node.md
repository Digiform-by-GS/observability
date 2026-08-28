# Node.js onboarding reference

Applies to Express, Fastify, Koa, plain `http` — anything that runs as a normal
Node process. **Next.js is different — see the last section.**

## Requirements

- Node `^18.19.0 || >=20.6.0` (enforced via `engines`; any 19.x is rejected).
- **ESM only.** The service's `package.json` needs `"type": "module"`. There is
  no CommonJS build — `--require` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
  If the service is CommonJS, converting it is a prerequisite; tell the user
  rather than attempting a workaround.

## Install

```bash
npm install @digiform-by-gs/observability@0.1.2   # exact pin: see references/compat.json
```

0.1.2 is a floor, not a preference. Earlier versions do not register the ESM
loader hook, so express/fastify/pg load unpatched while core `http` still works
— the service looks instrumented and every server span is named after the bare
method (`GET`), collapsing every route into one metric series.

## Wire it in — the preload (always prefer this)

Add the import flag to the start command, before the entrypoint:

```jsonc
// package.json
"scripts": {
  // before:  "start": "node src/index.js"
  "start": "node --import @digiform-by-gs/observability/preload src/index.js"
}
```

- `tsx`/`ts-node` users: keep their loader flag *and* add this one:
  `node --import tsx --import @digiform-by-gs/observability/preload src/index.ts`.
- Dockerfiles: change `CMD`/`ENTRYPOINT` the same way.
- Process managers (pm2, systemd): add the flag to the interpreter args, or set
  `NODE_OPTIONS="--import @digiform-by-gs/observability/preload"` in the unit's env.

That's the whole integration. HTTP servers, `fetch`/http clients, pg, redis,
amqplib and the rest of the auto-instrumentation set are traced with **zero code
changes**, and outbound requests carry `traceparent` automatically.

**Require `@digiform-by-gs/observability` ≥ 0.1.2.** Earlier versions did not
register OpenTelemetry's ESM loader hook, so in an ESM service every userland
package (express, fastify, pg, redis) loaded unpatched. Core `http` was still
instrumented, so traces appeared and the service looked correctly onboarded —
but server spans were named after the bare method (`GET`, `POST`) with no
`http.route`, and every endpoint collapsed into a single metric series. If a
service was onboarded on an older version, bump it and re-run verify.

**Never call `initObservability()` when the preload flag is present.** The
preload already initialized; a second call logs a warning and no-ops, but code
that *depends* on calling it (e.g. to pass options) conflicts with the preload
path. Options-requiring setups drop the preload and use inline init — and then
`initObservability()` must run before every other import, which one hoisted
`import` statement silently breaks. Prefer env vars + preload; treat inline
init as the escape hatch.

## Logging (recommended, 2 lines)

The package ships a pino logger whose records are automatically stamped with
`trace_id`/`span_id` when emitted inside a request:

```ts
import { getLogger } from '@digiform-by-gs/observability';
const log = getLogger();

log.info({ orderId, amount }, 'order created');
log.error({ err: { message: e.message, stack: e.stack } }, 'checkout failed');
```

- Structured fields first, constant message second (constant messages are what
  make logs greppable/queryable at scale).
- **Never add `trace_id` manually** — it's automatic, and a hand-added one
  shadows the real one.
- Extra fields are searchable per-request in the log store without being
  indexed, so high-cardinality ids in fields are safe (unlike in metrics).
- If the service already uses pino, replacing the logger instance with
  `getLogger()` preserves call sites. If it uses console.log/winston, replace
  incrementally — start with the request-path call sites.

**Do not add a pino transport for shipping logs** (`pino-opentelemetry-transport`
or similar). Transports run in a worker thread that has no access to the active
trace context, so every log arrives uncorrelated — the exact failure this
package's logger exists to prevent. Log shipping is already handled.

## Custom spans / metrics

Available when needed — `getTracer(name)`, `getMeter(name)` — but **not part of
onboarding**. Auto-instrumentation plus span-derived RED metrics cover the
baseline. Point the user at the `instrument` skill when they ask "how do I
trace my business logic".

## Environment variables

Set per the shared contract in SKILL.md Step 2. Node specifics:
- `OTEL_DEPLOYMENT_ENVIRONMENT` falls back to `NODE_ENV`, then `development`.
- `OTEL_SERVICE_VERSION` falls back to `npm_package_version`.
- Logger level is the `logLevel` option (inline init only), not an env var.

## Next.js — different path, no wrapper

The wrapper's dependency tree (sdk-node, pino, auto-instrumentations) is exactly
what Next's bundler and Edge runtime reject. Do **not** install
`@digiform-by-gs/observability` in a Next.js app. Instead:

```bash
npm install @vercel/otel@^2.1.3   # exact pin: see references/compat.json
```

**Install the pinned version explicitly.** A bare `npm install @vercel/otel`
resolved to the 1.x line on a real client and shipped: 1.x peers against
OpenTelemetry SDK 1.x, which cannot satisfy the 2.x SDK this platform is built
on. The version is not a detail you can leave to the resolver.

```ts
// instrumentation.ts at the project root (auto-detected by Next 15+)
import { registerOTel } from '@vercel/otel';
export function register() {
  registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'web' });
}
```

Same env-var contract. Server-side `fetch` auto-injects `traceparent`, so
Next → backend trace continuity works. Known limits to tell the user — state
these plainly rather than implying full coverage:
- Custom spans only in the Node runtime (`export const runtime = 'nodejs'`);
  middleware runs on Edge and is effectively un-instrumentable.
- `@vercel/otel` ships traces + metrics but **not logs** — correlated server
  logs from Next are not part of this onboarding.
- If the browser calls your backend directly rather than through Next API
  routes, this instruments **server-side rendering only**. It says nothing about
  what the user experienced. Say so — and offer the browser half, which is a
  separate package and a separate platform endpoint: see
  [browser.md](browser.md).

## Lockfiles are part of the patch, not a follow-up

After **any** `package.json` change:

```bash
npm install --package-lock-only --ignore-scripts
npm ci --dry-run                     # must resolve cleanly
```

Include `package-lock.json` in the diff. `--package-lock-only` writes no
`node_modules`, and `--ignore-scripts` blocks postinstall execution, so this is
safe to run in a sandbox — but it does make npm resolve the tree, which is the
only way to find out whether the version you chose is installable at all.

A `package.json` edited without its lockfile is a **broken** patch, not an
incomplete one: production Dockerfiles commonly run `npm ci`, which refuses
outright with *"npm ci can only install packages when your package.json and
package-lock.json are in sync"*. This shipped to a client once already.

If the repo has no lockfile at all, do not create one — that is a project-wide
decision, not yours. Say so in the PR body instead.

## `.env` — check whether it is tracked before deciding

The usual rule is to leave `.env` alone and list the required variables in the
PR body. That rule assumes `.env` is gitignored, which is not always true:

```bash
git check-ignore -q .env && echo "ignored" || git ls-files --error-unmatch .env
```

- **Gitignored** (normal) — do not edit it. Your change would be invisible in
  the diff, so the reviewer would never see the variables they must set. List
  them in the PR body.
- **Tracked in git** — editing it is correct and expected; that is how this
  repo distributes configuration. Add only the OTEL variables, never a secret,
  and note in the PR body that you touched a tracked file.
- **Absent** — create `.env.example` rather than `.env`.
