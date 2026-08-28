import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logs } from '@opentelemetry/api-logs';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';

import { registerErrorCapture } from '../src/errors.js';

let exporter: InMemoryLogRecordExporter;
let provider: LoggerProvider;
let detach: () => void;

// An 'error' event that nobody cancels is, to jsdom and to vitest, an uncaught
// exception - it fails the whole run even when every assertion passes. The
// library deliberately does NOT call preventDefault: swallowing the host
// application's errors would be a worse defect than a noisy test run, and the
// app's own error reporting must still see them. So suppression belongs here,
// applied only to the synthetic events these tests dispatch.
const suppressDefault = (event: Event): void => event.preventDefault();

beforeEach(() => {
  exporter = new InMemoryLogRecordExporter();
  // Options object, not a bare exporter — the signature changed in the 0.221
  // line. Passing it positionally leaves the processor with no exporter and it
  // silently records nothing, which is how this was first written.
  provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
  logs.setGlobalLoggerProvider(provider);
  window.addEventListener('error', suppressDefault);
  detach = registerErrorCapture();
});

afterEach(async () => {
  detach();
  window.removeEventListener('error', suppressDefault);
  await provider.shutdown();
  logs.disable();
});

describe('registerErrorCapture', () => {
  it('records an uncaught error with its stack', () => {
    const error = new TypeError('cannot read properties of undefined');
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: error.message,
        error,
        filename: 'app.js',
        lineno: 42,
        cancelable: true,
      }),
    );

    const [record] = exporter.getFinishedLogRecords();
    expect(record).toBeDefined();
    expect(record?.body).toBe('cannot read properties of undefined');
    expect(record?.attributes['exception.type']).toBe('TypeError');
    expect(record?.attributes['code.filepath']).toBe('app.js');
    expect(record?.attributes['code.lineno']).toBe(42);
  });

  it('records an unhandled promise rejection', () => {
    const event = new Event('unhandledrejection') as Event & { reason: unknown };
    (event as { reason: unknown }).reason = new Error('payment lookup failed');
    window.dispatchEvent(event);

    const [record] = exporter.getFinishedLogRecords();
    expect(record?.body).toBe('payment lookup failed');
    expect(record?.attributes['exception.escaped']).toBe(true);
  });

  // Rejections are frequently not Errors — `Promise.reject('nope')` or a
  // rejected fetch Response. Throwing while handling an error would replace a
  // reported problem with an unreported one.
  it('survives a rejection whose reason is not an Error', () => {
    const event = new Event('unhandledrejection') as Event & { reason: unknown };
    (event as { reason: unknown }).reason = 'nope';
    window.dispatchEvent(event);

    const [record] = exporter.getFinishedLogRecords();
    expect(record?.body).toBe('nope');
    expect(record?.attributes['exception.type']).toBe('string');
  });

  // A listener, never an assignment to window.onerror: the app may already have
  // its own error reporting installed, and clobbering it would be a silent
  // regression in someone else's product.
  it('does not displace an existing error handler', () => {
    const appHandler = vi.fn();
    window.addEventListener('error', appHandler);

    window.dispatchEvent(
      new ErrorEvent('error', { message: 'boom', error: new Error('boom'), cancelable: true }),
    );

    expect(appHandler).toHaveBeenCalledTimes(1);
    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
    window.removeEventListener('error', appHandler);
  });

  it('stops recording after detach', () => {
    detach();
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'boom', error: new Error('boom'), cancelable: true }),
    );
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
  });
});
