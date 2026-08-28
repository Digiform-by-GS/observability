import { metrics, trace, type Meter, type Tracer } from '@opentelemetry/api';
import { logs, type Logger } from '@opentelemetry/api-logs';

/**
 * Thin wrappers over the OTel globals, for custom spans, metrics, and logs.
 *
 * Unlike the Node wrapper's `getLogger()`, which returns a configured pino
 * instance and throws before init, these return the API's no-op
 * implementations when called early. That is the right behaviour in a browser:
 * module evaluation order in a bundle is not something the application author
 * fully controls, so a component that records a metric at import time must not
 * throw and break the page. Telemetry silently doing nothing is preferable to
 * a white screen.
 */
export function getTracer(name: string, version?: string): Tracer {
  return trace.getTracer(name, version);
}

export function getMeter(name: string, version?: string): Meter {
  return metrics.getMeter(name, version);
}

export function getLogger(name: string, version?: string): Logger {
  return logs.getLogger(name, version);
}
