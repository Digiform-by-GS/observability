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
npm install @digiform/observability
```

## Wire it in — the preload (always prefer this)

Add the import flag to the start command, before the entrypoint:

```jsonc
// package.json
"scripts": {
  // before:  "start": "node src/index.js"
  "start": "node --import @digiform/observability/preload src/index.js"
}
```

- `tsx`/`ts-node` users: keep their loader flag *and* add this one:
  `node --import tsx --import @digiform/observability/preload src/index.ts`.
- Dockerfiles: change `CMD`/`ENTRYPOINT` the same way.
- Process managers (pm2, systemd): add the flag to the interpreter args, or set
  `NODE_OPTIONS="--import @digiform/observability/preload"` in the unit's env.

That's the whole integration. HTTP servers, `fetch`/http clients, pg, redis,
amqplib and the rest of the auto-instrumentation set are traced with **zero code
changes**, and outbound requests carry `traceparent` automatically.

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
import { getLogger } from '@digiform/observability';
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
`@digiform/observability` in a Next.js app. Instead:

```bash
npm install @vercel/otel
```

```ts
// instrumentation.ts at the project root (auto-detected by Next 15+)
import { registerOTel } from '@vercel/otel';
export function register() {
  registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'web' });
}
```

Same env-var contract. Server-side `fetch` auto-injects `traceparent`, so
Next → backend trace continuity works. Known limits to tell the user:
- Custom spans only in the Node runtime (`export const runtime = 'nodejs'`);
  middleware runs on Edge and is effectively un-instrumentable.
- `@vercel/otel` ships traces + metrics but **not logs** — correlated server
  logs from Next are not part of this onboarding.
