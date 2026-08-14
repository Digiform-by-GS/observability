import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';

import { resolveConfig } from './config.js';
import { buildResource } from './resource.js';
import { createLogger } from './logging.js';
import { setLogger, clearLogger } from './accessors.js';
import { registerShutdown } from './shutdown.js';
import type { ObservabilityHandle, ObservabilityOptions } from './types.js';

// `started` lives on globalThis so it's shared across separately-bundled entries
// (`dist/index.js` and `dist/preload.js`) — see accessors.ts for the same pattern.
const GLOBAL_STARTED_KEY = '__digiform_observability_started__';
type GlobalWithStarted = typeof globalThis & { [GLOBAL_STARTED_KEY]?: boolean };

function isStarted(): boolean {
  return (globalThis as GlobalWithStarted)[GLOBAL_STARTED_KEY] === true;
}
function markStarted(value: boolean): void {
  (globalThis as GlobalWithStarted)[GLOBAL_STARTED_KEY] = value;
}

export function initObservability(options: ObservabilityOptions = {}): ObservabilityHandle {
  if (isStarted()) {
    console.warn(
      '[@digiform-by-gs/observability] initObservability() called more than once — ignoring subsequent call.',
    );
    return { shutdown: async () => {} };
  }

  const config = resolveConfig(options);
  const resource = buildResource(config);

  // `headers` is spread conditionally so an absent option leaves the exporters
  // free to resolve OTEL_EXPORTER_OTLP_HEADERS (and per-signal variants) from
  // the environment; passing `headers: undefined` explicitly would be fine
  // today but this keeps intent unmistakable.
  const exporterHeaders = config.headers ? { headers: config.headers } : {};
  const traceExporter = new OTLPTraceExporter({ url: `${config.endpoint}/v1/traces`, ...exporterHeaders });
  const metricExporter = new OTLPMetricExporter({ url: `${config.endpoint}/v1/metrics`, ...exporterHeaders });
  const logExporter = new OTLPLogExporter({ url: `${config.endpoint}/v1/logs`, ...exporterHeaders });

  const instrumentations = config.instrumentations
    ? config.instrumentations
    : config.disableAutoInstrumentations
      ? config.additionalInstrumentations
      : [
          // Logs are bridged to the OTel Logs API manually in logging.ts, so
          // disable instrumentation-pino to avoid emitting each record twice.
          ...getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-pino': { enabled: false },
          }),
          ...config.additionalInstrumentations,
        ];

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: config.metricExportIntervalMs,
    }),
    logRecordProcessors: [new BatchLogRecordProcessor(logExporter)],
    instrumentations,
  });

  sdk.start();
  markStarted(true);

  const logger = createLogger(config);
  setLogger(logger);

  const handle = registerShutdown(sdk, logger);

  return {
    async shutdown(): Promise<void> {
      await handle.shutdown();
      clearLogger();
      markStarted(false);
    },
  };
}

export function __resetForTests(): void {
  markStarted(false);
  clearLogger();
  // Also release the OTel global providers. The API refuses duplicate global
  // registration, so without this a second initObservability() in the same
  // process registers nothing: spans silently route to the previous (shut
  // down) provider and never export. Only unmocked tests notice — the SDK
  // mocks in init.test.ts never touch the real globals.
  trace.disable();
  metrics.disable();
  logs.disable();
  context.disable();
  propagation.disable();
}
