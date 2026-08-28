import type { BrowserObservabilityOptions, ResolvedBrowserConfig } from './types.js';

const DEFAULT_METRIC_INTERVAL_MS = 60_000;
const PREFIX = '[@digiform-by-gs/observability-browser]';

/**
 * Resolves options to a complete config.
 *
 * Note what is missing compared with the Node wrapper: there is no environment
 * layer. `process.env` does not exist in a browser, and a bundler replaces
 * `process.env.X` at BUILD time with a literal, so an "env fallback" here would
 * be a value frozen when the bundle was compiled while looking like something
 * read at runtime. Options are the only input; the app is responsible for
 * feeding its own build-time variables in.
 */
export function resolveConfig(options: BrowserObservabilityOptions): ResolvedBrowserConfig {
  if (!options.serviceName) {
    throw new Error(
      `${PREFIX} serviceName is required. There is no OTEL_SERVICE_NAME to fall back to in a browser — pass it explicitly, e.g. initBrowserObservability({ serviceName: 'my-app-browser' }).`,
    );
  }

  if (!options.endpoint) {
    throw new Error(
      `${PREFIX} endpoint is required and has no default. In a browser, 'localhost' means the VISITOR's machine, so a default would silently fail for every real user. Pass the platform's browser OTLP endpoint, e.g. { endpoint: 'http://collector.internal:4319' }.`,
    );
  }

  return {
    serviceName: options.serviceName,
    serviceVersion: options.serviceVersion ?? '0.0.0',
    environment: options.environment ?? 'production',
    endpoint: stripTrailingSlash(options.endpoint),
    propagateTo: options.propagateTo ?? [],
    headers: options.headers,
    resourceAttributes: options.resourceAttributes ?? {},
    route: options.route ?? (() => 'unknown'),
    captureErrors: options.captureErrors ?? true,
    captureWebVitals: options.captureWebVitals ?? true,
    instrumentations: options.instrumentations,
    additionalInstrumentations: options.additionalInstrumentations ?? [],
    metricExportIntervalMs: options.metricExportIntervalMs ?? DEFAULT_METRIC_INTERVAL_MS,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
