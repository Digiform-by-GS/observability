import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Swap heavy SDK + worker-spawning surfaces for plain stubs so init.ts runs
// without network or worker threads. Plain functions/classes here (no vi.fn())
// so `clearMocks` doesn't reset implementations between tests.
vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    start() {}
    async shutdown() {}
  },
}));
vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: () => [],
}));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: class {} }));
vi.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({ OTLPMetricExporter: class {} }));
vi.mock('@opentelemetry/exporter-logs-otlp-http', () => ({ OTLPLogExporter: class {} }));
vi.mock('@opentelemetry/sdk-metrics', () => ({ PeriodicExportingMetricReader: class {} }));
vi.mock('@opentelemetry/sdk-logs', () => ({ BatchLogRecordProcessor: class {} }));

vi.mock('../src/logging.js', () => ({
  createLogger: () => ({
    flush: (cb: (err?: Error) => void) => cb(),
    info: () => {},
  }),
}));

import { initObservability, __resetForTests } from '../src/init.js';
import { getLogger, getTracer, getMeter } from '../src/accessors.js';

describe('initObservability', () => {
  beforeEach(() => {
    __resetForTests();
    process.env.OTEL_SERVICE_NAME = 'test-svc';
  });

  afterEach(() => {
    delete process.env.OTEL_SERVICE_NAME;
  });

  it('returns a handle with a shutdown function', async () => {
    const handle = initObservability({ serviceName: 'unit-svc' });
    expect(handle).toHaveProperty('shutdown');
    expect(typeof handle.shutdown).toBe('function');
    await handle.shutdown();
  });

  it('second call is a no-op and logs a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = initObservability({ serviceName: 'svc' });
    const second = initObservability({ serviceName: 'svc' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('called more than once'));
    await first.shutdown();
    await second.shutdown();
    warn.mockRestore();
  });

  it('throws when serviceName is missing', () => {
    delete process.env.OTEL_SERVICE_NAME;
    expect(() => initObservability()).toThrowError(/serviceName is required/);
  });

  it('accessors throw before init', () => {
    __resetForTests();
    expect(() => getLogger()).toThrowError(/called before initObservability/);
  });

  it('accessors work after init', async () => {
    const handle = initObservability({ serviceName: 'svc' });
    expect(getLogger()).toBeDefined();
    expect(getTracer('unit')).toBeDefined();
    expect(getMeter('unit')).toBeDefined();
    await handle.shutdown();
  });
});
