# @digiform/observability

Batteries-included OpenTelemetry wrapper for Node.js. One install, two lines of code, and your service emits trace-correlated logs, traces, and metrics over OTLP/HTTP.

Pairs with the LGTM + OTel Collector stack in the root of this repo.

## Install

```bash
npm install @digiform/observability
```

Node 18.19+ or 20.6+ (floor set by `@opentelemetry/sdk-node`). ESM only — your service needs
`"type": "module"`.

## Quickstart — inline init

```ts
// Must be the FIRST thing your entry file does, before any other imports that
// you want instrumented (express, http, pg, etc).
import { initObservability } from '@digiform/observability';

const obs = initObservability({
  serviceName: 'my-service',
  environment: 'production',
});

import express from 'express';
import { getLogger } from '@digiform/observability';

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
node --import @digiform/observability/preload src/index.js
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

| Option | Type | Default | Notes |
|---|---|---|---|
| `serviceName` | `string` | — | Required unless `OTEL_SERVICE_NAME` is set. |
| `serviceVersion` | `string` | `npm_package_version` or `'0.0.0'` | |
| `environment` | `string` | `NODE_ENV` or `'development'` | |
| `endpoint` | `string` | `http://localhost:4318` | OTLP/HTTP base URL. |
| `resourceAttributes` | `Record<string, string>` | `{}` | Merged with `OTEL_RESOURCE_ATTRIBUTES`. |
| `instrumentations` | `Instrumentation[]` | — | If set, replaces the auto-instrumentations entirely. |
| `additionalInstrumentations` | `Instrumentation[]` | `[]` | Appended to the auto-instrumentations. |
| `disableAutoInstrumentations` | `boolean` | `false` | Escape hatch. |
| `metricExportIntervalMs` | `number` | `60000` | |
| `logLevel` | `pino.Level` | `'info'` | |

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

- `OTEL_SERVICE_NAME`
- `OTEL_SERVICE_VERSION`
- `OTEL_DEPLOYMENT_ENVIRONMENT`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_RESOURCE_ATTRIBUTES`
- `OTEL_NODE_DISABLED_INSTRUMENTATIONS` (honoured by `getNodeAutoInstrumentations()`)

Plus any `OTEL_*` env var the core SDK understands.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "getLogger() called before initObservability()" | Move `initObservability()` above the offending import, or switch to the preload pattern. |
| Logs arrive in Loki without `service_name` label | You're using the preload with no `OTEL_SERVICE_NAME` set. Set it. |
| Traces arrive but instrumentation is missing for a library | Likely imported before `initObservability()` ran. Use preload. |
| No data anywhere | Is the Collector running and reachable on `$OTEL_EXPORTER_OTLP_ENDPOINT`? `curl $OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces -d '{}' -H 'Content-Type: application/json'` should return 200. |

## Graceful shutdown

`initObservability()` registers `SIGTERM` and `SIGINT` handlers that flush pending spans, metrics, and logs before exit. You can also call `handle.shutdown()` yourself — e.g. from `beforeExit` — if you want to control the shutdown path.
