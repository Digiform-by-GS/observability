import type { ObservabilityOptions, ResolvedConfig } from './types.js';

const DEFAULT_ENDPOINT = 'http://localhost:4318';
const DEFAULT_METRIC_INTERVAL_MS = 60_000;

export function resolveConfig(options: ObservabilityOptions = {}): ResolvedConfig {
  const serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME;

  if (!serviceName) {
    throw new Error(
      '[@digiform-by-gs/observability] serviceName is required. Pass it via initObservability({ serviceName }) or set OTEL_SERVICE_NAME.',
    );
  }

  const serviceVersion =
    options.serviceVersion ??
    process.env.OTEL_SERVICE_VERSION ??
    process.env.npm_package_version ??
    '0.0.0';

  const environment =
    options.environment ??
    process.env.OTEL_DEPLOYMENT_ENVIRONMENT ??
    process.env.NODE_ENV ??
    'development';

  const endpoint =
    options.endpoint ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    DEFAULT_ENDPOINT;

  const resourceAttributes = {
    ...parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES),
    ...(options.resourceAttributes ?? {}),
  };

  const metricExportIntervalMs =
    options.metricExportIntervalMs ?? DEFAULT_METRIC_INTERVAL_MS;

  return {
    serviceName,
    serviceVersion,
    environment,
    endpoint: stripTrailingSlash(endpoint),
    // Pass-through only. OTEL_EXPORTER_OTLP_HEADERS is intentionally not read
    // here — the exporters resolve it themselves (with per-signal overrides),
    // and this wrapper must not shadow that.
    headers: options.headers,
    resourceAttributes,
    instrumentations: options.instrumentations,
    additionalInstrumentations: options.additionalInstrumentations ?? [],
    disableAutoInstrumentations: options.disableAutoInstrumentations ?? false,
    metricExportIntervalMs,
    logLevel: options.logLevel ?? 'info',
  };
}

function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
