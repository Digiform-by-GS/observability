import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceFlags, context, trace, type SpanContext } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { SeverityNumber } from '@opentelemetry/api-logs';
import type { ResolvedConfig } from '../src/types.js';

/**
 * Regression guard for log↔trace correlation.
 *
 * The bridge in src/logging.ts must hand each pino record to the OTel Logs API
 * *synchronously, on the calling thread*, because `emit()` stamps the record
 * with whatever `context.active()` holds at that moment. The original
 * implementation shipped logs through `pino-opentelemetry-transport`, which
 * runs in a worker thread that cannot see the active context — so every log
 * reached Loki with an empty TraceId and correlation silently broke.
 *
 * These tests fail if anyone reintroduces an async/worker hop between the log
 * call and `emit()`.
 */

// vi.mock factories are hoisted above imports, so the buffer they write to must
// be hoisted too.
const captured = vi.hoisted(() => {
  return [] as Array<{
    record: Record<string, unknown>;
    activeTraceId: string | undefined;
    activeSpanId: string | undefined;
  }>;
});

vi.mock('@opentelemetry/api-logs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api-logs')>();
  const { trace: apiTrace } = await import('@opentelemetry/api');
  return {
    ...actual,
    logs: {
      getLogger: () => ({
        emit(record: Record<string, unknown>) {
          // Snapshot the active span AT EMIT TIME — this is the property under test.
          const sc = apiTrace.getActiveSpan()?.spanContext();
          captured.push({ record, activeTraceId: sc?.traceId, activeSpanId: sc?.spanId });
        },
      }),
    },
  };
});

const { createLogger } = await import('../src/logging.js');

const config: ResolvedConfig = {
  serviceName: 'test-svc',
  serviceVersion: '1.0.0',
  environment: 'test',
  endpoint: 'http://localhost:4318',
  resourceAttributes: {},
  additionalInstrumentations: [],
  disableAutoInstrumentations: false,
  metricExportIntervalMs: 60_000,
  logLevel: 'info',
};

const SPAN_CONTEXT: SpanContext = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  traceFlags: TraceFlags.SAMPLED,
};

/** Run `fn` with a span active, the way an instrumented request handler would. */
function withActiveSpan<T>(fn: () => T): T {
  const span = trace.wrapSpanContext(SPAN_CONTEXT);
  return context.with(trace.setSpan(context.active(), span), fn);
}

describe('createLogger — OTel Logs bridge', () => {
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });

  afterAll(() => {
    context.disable();
  });

  beforeEach(() => {
    // The bridge mirrors every line to stdout; keep test output clean.
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    captured.length = 0;
  });

  it('emits inside the caller\'s active span context (the correlation guarantee)', () => {
    const log = createLogger(config);

    withActiveSpan(() => {
      log.info('inside span');
    });

    expect(captured).toHaveLength(1);
    // If emit() were deferred to a worker/async hop, the active span would be
    // gone by the time it ran and these would be undefined.
    expect(captured[0]?.activeTraceId).toBe(SPAN_CONTEXT.traceId);
    expect(captured[0]?.activeSpanId).toBe(SPAN_CONTEXT.spanId);
  });

  it('emits synchronously — the record is captured before the log call returns', () => {
    const log = createLogger(config);

    withActiveSpan(() => {
      log.info('sync check');
      // No await, no tick: a worker-thread transport would still be empty here.
      expect(captured).toHaveLength(1);
    });
  });

  it('still emits outside a span, just without trace context', () => {
    const log = createLogger(config);

    log.info('no span here');

    expect(captured).toHaveLength(1);
    expect(captured[0]?.activeTraceId).toBeUndefined();
    expect(captured[0]?.activeSpanId).toBeUndefined();
  });

  it('maps the pino record onto the OTel LogRecord shape', () => {
    const log = createLogger(config);

    log.info({ orderId: 'abc-123', amount: 42 }, 'order created');

    const record = captured[0]?.record ?? {};
    expect(record.body).toBe('order created');
    expect(record.severityNumber).toBe(SeverityNumber.INFO);
    expect(record.severityText).toBe('info');
    expect(typeof record.timestamp).toBe('number');

    // Extra fields become attributes so they're queryable in Loki...
    expect(record.attributes).toMatchObject({ orderId: 'abc-123', amount: 42 });
    // ...but pino's own bookkeeping maps to LogRecord fields, not attributes.
    for (const k of ['level', 'time', 'msg', 'pid', 'hostname']) {
      expect(record.attributes).not.toHaveProperty(k);
    }
  });

  it('maps pino levels to OTel severity numbers', () => {
    const log = createLogger({ ...config, logLevel: 'trace' });

    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');

    expect(captured.map((c) => c.record.severityNumber)).toEqual([
      SeverityNumber.TRACE,
      SeverityNumber.DEBUG,
      SeverityNumber.INFO,
      SeverityNumber.WARN,
      SeverityNumber.ERROR,
      SeverityNumber.FATAL,
    ]);
  });

  it('respects the configured level', () => {
    const log = createLogger({ ...config, logLevel: 'warn' });

    log.info('dropped');
    log.warn('kept');

    expect(captured.map((c) => c.record.body)).toEqual(['kept']);
  });

  it('correlates every record in a request to the same trace', () => {
    const log = createLogger(config);

    withActiveSpan(() => {
      log.info('request received');
      log.warn('about to fail');
      log.error({ err: { message: 'boom' } }, 'unhandled error');
    });

    expect(captured).toHaveLength(3);
    for (const c of captured) {
      expect(c.activeTraceId).toBe(SPAN_CONTEXT.traceId);
    }
  });
});
