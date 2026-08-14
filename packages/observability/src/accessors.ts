import { metrics, trace, type Meter, type Tracer } from '@opentelemetry/api';
import type { Logger } from 'pino';

// Shared state is stored on globalThis so the value is visible across multiple
// bundle copies of this module. When the wrapper is consumed via both the
// `preload` entry and the main `index` entry, tsup bundles each entry
// independently — each ends up with its own module-local variables. Pinning
// the singleton to globalThis bridges them.
const GLOBAL_LOGGER_KEY = '__digiform_observability_logger__';
type GlobalWithLogger = typeof globalThis & {
  [GLOBAL_LOGGER_KEY]?: Logger | null;
};

export function setLogger(logger: Logger): void {
  (globalThis as GlobalWithLogger)[GLOBAL_LOGGER_KEY] = logger;
}

export function clearLogger(): void {
  (globalThis as GlobalWithLogger)[GLOBAL_LOGGER_KEY] = null;
}

export function getTracer(name: string, version?: string): Tracer {
  return trace.getTracer(name, version);
}

export function getMeter(name: string, version?: string): Meter {
  return metrics.getMeter(name, version);
}

export function getLogger(): Logger {
  const logger = (globalThis as GlobalWithLogger)[GLOBAL_LOGGER_KEY];
  if (!logger) {
    throw new Error(
      '[@digiform-by-gs/observability] getLogger() called before initObservability(). Call initObservability first.',
    );
  }
  return logger;
}
