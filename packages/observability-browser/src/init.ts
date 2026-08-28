import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';

import { resolveConfig } from './config.js';
import { ignorePattern } from './ignore.js';
import { buildResource } from './resource.js';
import { registerErrorCapture } from './errors.js';
import { registerWebVitals } from './vitals.js';
import { registerUnloadFlush } from './unload.js';
import type {
  BrowserObservabilityHandle,
  BrowserObservabilityOptions,
} from './types.js';

const PREFIX = '[@digiform-by-gs/observability-browser]';

// Mirrors the Node wrapper: shared state lives on globalThis so it survives
// multiple bundled copies of this module, which is easy to end up with when a
// bundler code-splits.
const GLOBAL_STARTED_KEY = '__digiform_observability_browser_started__';
type GlobalWithStarted = typeof globalThis & { [GLOBAL_STARTED_KEY]?: boolean };

function isStarted(): boolean {
  return (globalThis as GlobalWithStarted)[GLOBAL_STARTED_KEY] === true;
}
function markStarted(value: boolean): void {
  (globalThis as GlobalWithStarted)[GLOBAL_STARTED_KEY] = value;
}

const NOOP_HANDLE: BrowserObservabilityHandle = {
  shutdown: async () => {},
  flush: async () => {},
};

export function initBrowserObservability(
  options: BrowserObservabilityOptions,
): BrowserObservabilityHandle {
  // Server-side rendering imports this module too. Touching `window` during SSR
  // throws and takes the render down, so bail before anything else — a frontend
  // must not break because its telemetry could not start.
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return NOOP_HANDLE;
  }

  if (isStarted()) {
    console.warn(`${PREFIX} initBrowserObservability() called more than once — ignoring subsequent call.`);
    return NOOP_HANDLE;
  }

  const config = resolveConfig(options);
  const resource = buildResource(config);

  const exporterHeaders = config.headers ? { headers: config.headers } : {};
  const traceExporter = new OTLPTraceExporter({ url: `${config.endpoint}/v1/traces`, ...exporterHeaders });
  const metricExporter = new OTLPMetricExporter({ url: `${config.endpoint}/v1/metrics`, ...exporterHeaders });
  const logExporter = new OTLPLogExporter({ url: `${config.endpoint}/v1/logs`, ...exporterHeaders });

  const spanProcessor = new BatchSpanProcessor(traceExporter);
  const tracerProvider = new WebTracerProvider({ resource, spanProcessors: [spanProcessor] });

  // W3C trace context explicitly. The browser SDK's default is not guaranteed
  // to be the same propagator the Go and Node services use, and a mismatch is
  // silent — headers are written in a format nothing downstream reads, so
  // traces simply never join.
  tracerProvider.register({ propagator: new W3CTraceContextPropagator() });

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: config.metricExportIntervalMs,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  // Options object, not a bare exporter: the signature changed in the 0.221
  // line. The Node wrapper still passes the exporter positionally because it
  // is pinned to 0.215 — the two packages are deliberately on different
  // OpenTelemetry lines, since the browser instrumentations pin sdk-trace-web
  // exactly and force the newer one.
  const logRecordProcessor = new BatchLogRecordProcessor({ exporter: logExporter });
  const loggerProvider = new LoggerProvider({ resource, processors: [logRecordProcessor] });
  logs.setGlobalLoggerProvider(loggerProvider);

  registerInstrumentations({
    instrumentations: config.instrumentations ?? [
      new DocumentLoadInstrumentation(),
      new FetchInstrumentation({
        propagateTraceHeaderCorsUrls: config.propagateTo,
        // Without this the exporter's own POST is traced, which produces a span,
        // which is exported, which produces a span. A self-sustaining loop that
        // saturates the collector from every open tab. `ignoreUrls` on the
        // endpoint is what breaks it, and it is not optional.
        ignoreUrls: [ignorePattern(config.endpoint)],
        clearTimingResources: true,
      }),
      new XMLHttpRequestInstrumentation({
        propagateTraceHeaderCorsUrls: config.propagateTo,
        ignoreUrls: [ignorePattern(config.endpoint)],
      }),
      ...config.additionalInstrumentations,
    ],
  });

  if (config.captureWebVitals) registerWebVitals(config.route);
  const detachErrors = config.captureErrors ? registerErrorCapture() : () => {};

  const flush = async (): Promise<void> => {
    await Promise.all([
      spanProcessor.forceFlush(),
      meterProvider.forceFlush(),
      logRecordProcessor.forceFlush(),
    ]);
  };

  // Fire-and-forget on hide: the page may be gone before a promise settles, so
  // there is nothing useful to await. Errors are swallowed deliberately —
  // telemetry failing during unload must not surface to the user.
  const detachUnload = registerUnloadFlush(() => {
    void flush().catch(() => {});
  });

  markStarted(true);

  return {
    flush,
    async shutdown(): Promise<void> {
      detachUnload();
      detachErrors();
      await Promise.all([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
      markStarted(false);
    },
  };
}

export function __resetForTests(): void {
  markStarted(false);
  trace.disable();
  metrics.disable();
  logs.disable();
  context.disable();
  propagation.disable();
}
