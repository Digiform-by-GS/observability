# @digiform-by-gs/observability

Batteries-included OpenTelemetry wrapper for Node.js. One install, two lines of code, and your service emits trace-correlated logs, traces, and metrics over OTLP/HTTP.

Pairs with the LGTM + OTel Collector stack in the root of this repo.

## Install

```bash
npm install @digiform-by-gs/observability
```

Node 18.19+ or 20.6+ (floor set by `@opentelemetry/sdk-node`). ESM only — your service needs
`"type": "module"`.

## Quickstart — inline init

```ts
// Must be the FIRST thing your entry file does, before any other imports that
// you want instrumented (express, http, pg, etc).
import { initObservability } from '@digiform-by-gs/observability';

const obs = initObservability({
  serviceName: 'my-service',
  environment: 'production',
});

import express from 'express';
import { getLogger } from '@digiform-by-gs/observability';

const app = express();
const log = getLogger();

app.get('/', (_req, res) => {
  log.info({ route: '/' }, 'hello');
  res.send('ok');
});

app.listen(8080);

process.on('beforeExit', () => obs.shutdown());
```

## Quickstart — preload (recommended for production)

The inline pattern above only works if nothing in your module graph gets imported before `initObservability()`. For real apps, use the preload entry:

```bash
node --import @digiform-by-gs/observability/preload src/index.js
```

This package is **ESM-only** — there is no CommonJS build. `--require` fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED`; your service needs `"type": "module"`.

Config comes from env vars:

```bash
export OTEL_SERVICE_NAME=my-service
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_DEPLOYMENT_ENVIRONMENT=production
```

## API

### `initObservability(options?)`

Returns `{ shutdown: () => Promise<void> }`. Calling it twice logs a warning and is a no-op.

| Option | Type | Example | Default | Notes |
|---|---|---|---|---|
| `serviceName` | `string` | `'orders'` | — | Required unless `OTEL_SERVICE_NAME` is set. |
| `serviceVersion` | `string` | `'1.4.2'` | `npm_package_version` or `'0.0.0'` | |
| `environment` | `string` | `'production'` | `NODE_ENV` or `'development'` | |
| `endpoint` | `string` | `'http://localhost:4318'` | `http://localhost:4318` | OTLP/HTTP base URL. |
| `resourceAttributes` | `Record<string, string>` | `{ team: 'payments' }` | `{}` | Merged with `OTEL_RESOURCE_ATTRIBUTES`. |
| `instrumentations` | `Instrumentation[]` | — | — | If set, replaces the auto-instrumentations entirely. |
| `additionalInstrumentations` | `Instrumentation[]` | — | `[]` | Appended to the auto-instrumentations. |
| `disableAutoInstrumentations` | `boolean` | `true` | `false` | Escape hatch. |
| `metricExportIntervalMs` | `number` | `15000` | `60000` | |
| `logLevel` | `pino.Level` | `'debug'` | `'info'` | |

Precedence: option > env var > default.

### `getTracer(name, version?) → Tracer`, `getMeter(name, version?) → Meter`

Thin wrappers over the OTel global providers. Use for custom spans / metrics.

### `getLogger() → pino.Logger`

Returns the pre-configured pino instance. Every record is auto-stamped with `trace_id` and `span_id` when a span is active, and shipped to Loki via OTLP logs.

Throws if called before `initObservability()`.

## Correlation

Every signal carries the same `service.name`, `service.version`, and `deployment.environment` attributes, so Grafana can join across them:

- **Log → trace**: every log line carries `trace_id` as OTLP **structured metadata** (not in the log body); the Loki datasource in this repo's provisioning uses a `derivedFields` entry with `matcherType: label` to turn it into a "View Trace" link to Tempo.
- **Trace → log**: Tempo's `tracesToLogsV2` points at Loki — click any span to pull its log lines.
- **Trace ↔ metric**: Tempo's metrics_generator emits span-metrics with `trace_id` exemplars; exemplars are surfaced on Mimir dashboards and link back to Tempo.

## Environment variables honoured

| Variable | Example |
|---|---|
| `OTEL_SERVICE_NAME` | `orders` |
| `OTEL_SERVICE_VERSION` | `1.4.2` |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | `production` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` |
| `OTEL_RESOURCE_ATTRIBUTES` | `team=payments,region=eu-west-1` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer abc123` (needed by authenticated collectors; merges with the `headers` option) |
| `OTEL_NODE_DISABLED_INSTRUMENTATIONS` | `fs,dns` (honoured by `getNodeAutoInstrumentations()`) |

Plus any `OTEL_*` env var the core SDK understands.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "getLogger() called before initObservability()" | Move `initObservability()` above the offending import, or switch to the preload pattern. |
| Logs arrive in Loki without `service_name` label | You're using the preload with no `OTEL_SERVICE_NAME` set. Set it. |
| Traces arrive but instrumentation is missing for a library | Likely imported before `initObservability()` ran. Use preload. |
| Server spans named `GET`/`POST` with no route, so every endpoint shares one metric series | The ESM loader hook is not active — express/fastify/pg/redis load unpatched while core `http` still works, so it looks instrumented. Needs **≥ 0.1.2**, which registers the hook. Confirm with `OTEL_LOG_LEVEL=debug`: you should see `instrumentation-express Applying instrumentation patch`. |
| No data anywhere | Is the Collector running and reachable on `$OTEL_EXPORTER_OTLP_ENDPOINT`? `curl $OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces -d '{}' -H 'Content-Type: application/json'` should return 200. |

## Graceful shutdown

`initObservability()` registers `SIGTERM`, `SIGINT`, and `beforeExit` handlers that flush pending spans, metrics, and logs before exit. You can also call `handle.shutdown()` yourself if you want to control the shutdown path.

The `beforeExit` handler is what covers **short-lived processes** — CLI tools, cron jobs, migrations, seed scripts, test harnesses. They receive no signal, so before 0.1.1 they exited while the batch processors still held their telemetry and everything was lost silently, with no error and nothing in the collector log. Long-running servers were never affected because they get `SIGTERM`.

Two cases `beforeExit` cannot cover, by Node's design: an explicit `process.exit()`, and an uncaught exception. If your script calls `process.exit()`, `await handle.shutdown()` first — or drop the explicit exit and let the process end naturally.
