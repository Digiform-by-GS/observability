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
  it('registers SIGTERM and SIGINT handlers, removes them on explicit shutdown', async () => {
    const sdk = makeSdk();
    const logger = makeLogger();

    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    };

    const handle = registerShutdown(sdk, logger);

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);

    await handle.shutdown();

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
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
