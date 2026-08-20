import { describe, expect, it, vi } from 'vitest';
import { registerShutdown } from '../src/shutdown.js';

function makeSdk() {
  return {
    start: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('@opentelemetry/sdk-node').NodeSDK;
}

function makeLogger() {
  return {
    flush: vi.fn((cb: (err?: Error) => void) => cb()),
  } as unknown as import('pino').Logger;
}

describe('registerShutdown', () => {
  it('registers SIGTERM, SIGINT and beforeExit handlers, removes them on explicit shutdown', async () => {
    const sdk = makeSdk();
    const logger = makeLogger();

    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
      beforeExit: process.listenerCount('beforeExit'),
    };

    const handle = registerShutdown(sdk, logger);

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    expect(process.listenerCount('beforeExit')).toBe(before.beforeExit + 1);

    await handle.shutdown();

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('beforeExit')).toBe(before.beforeExit);
    expect(sdk.shutdown).toHaveBeenCalledOnce();
    expect(logger.flush).toHaveBeenCalledOnce();
  });

  // Regression guard for silently-lost telemetry in short-lived processes.
  // A script that runs to completion gets no SIGTERM/SIGINT, and on the
  // preload path there is no handle to call shutdown() with — so 'beforeExit'
  // is the only thing that can flush. Verified against the live platform:
  // before this existed, a naturally-exiting process delivered nothing at all,
  // and the collector logged no error because nothing was ever sent.
  it('flushes on natural exit (beforeExit) without an explicit shutdown call', async () => {
    const sdk = makeSdk();
    const logger = makeLogger();

    registerShutdown(sdk, logger);
    process.emit('beforeExit', 0);
    // run() is async; give its microtasks a turn.
    await new Promise((resolve) => setImmediate(resolve));

    expect(sdk.shutdown).toHaveBeenCalledOnce();
    expect(logger.flush).toHaveBeenCalledOnce();
  });

  // 'beforeExit' re-fires if the handler's async work revives the event loop,
  // so the guard must hold across a second emit as well as across an emit
  // followed by an explicit shutdown().
  it('does not flush twice when beforeExit fires repeatedly', async () => {
    const sdk = makeSdk();
    const logger = makeLogger();

    const handle = registerShutdown(sdk, logger);
    process.emit('beforeExit', 0);
    process.emit('beforeExit', 0);
    await new Promise((resolve) => setImmediate(resolve));
    await handle.shutdown();

    expect(sdk.shutdown).toHaveBeenCalledOnce();
    expect(logger.flush).toHaveBeenCalledOnce();
  });

  it('does not double-shutdown when called twice', async () => {
    const sdk = makeSdk();
    const logger = makeLogger();

    const handle = registerShutdown(sdk, logger);
    await handle.shutdown();
    await handle.shutdown();

    expect(sdk.shutdown).toHaveBeenCalledOnce();
    expect(logger.flush).toHaveBeenCalledOnce();
  });

  it('survives an sdk.shutdown() rejection and still flushes the logger', async () => {
    const err = new Error('boom');
    const sdk = {
      shutdown: vi.fn().mockRejectedValue(err),
    } as unknown as import('@opentelemetry/sdk-node').NodeSDK;
    const logger = makeLogger();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handle = registerShutdown(sdk, logger);
    await handle.shutdown();

    expect(logger.flush).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('handles a null logger (no flush to perform)', async () => {
    const sdk = makeSdk();
    const handle = registerShutdown(sdk, null);
    await handle.shutdown();
    expect(sdk.shutdown).toHaveBeenCalledOnce();
  });
});
