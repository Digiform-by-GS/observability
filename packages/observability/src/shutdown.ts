import type { NodeSDK } from '@opentelemetry/sdk-node';
import type { Logger } from 'pino';

type Signal = 'SIGTERM' | 'SIGINT';
const SIGNALS: Signal[] = ['SIGTERM', 'SIGINT'];

export interface ShutdownHandle {
  shutdown(): Promise<void>;
}

export function registerShutdown(sdk: NodeSDK, logger: Logger | null): ShutdownHandle {
  let fired = false;

  const run = async (): Promise<void> => {
    if (fired) return;
    fired = true;
    try {
      await sdk.shutdown();
    } catch (err) {
      // Best-effort; continue flushing the logger even if SDK shutdown fails.
      console.error('[@digiform-by-gs/observability] sdk.shutdown() failed:', err);
    }
    if (logger) {
      await new Promise<void>((resolve) => {
        logger.flush((err) => {
          if (err) console.error('[@digiform-by-gs/observability] logger.flush() failed:', err);
          resolve();
        });
      });
    }
  };

  const signalHandlers = new Map<Signal, () => void>();
  for (const sig of SIGNALS) {
    const handler = (): void => {
      void run().finally(() => process.exit(0));
    };
    signalHandlers.set(sig, handler);
    process.once(sig, handler);
  }

  // Natural exit — the event loop drained and nothing sent SIGTERM/SIGINT.
  // Without this, any process that simply runs to completion exits while the
  // batch processors still hold its telemetry, and everything it emitted is
  // lost with no error anywhere: CLI tools, cron jobs, migrations, seed
  // scripts, short test harnesses. Servers were fine (they get SIGTERM), which
  // is why this hid for so long.
  //
  // It matters most on the preload path, which is the recommended integration:
  // the caller never receives the handle, so `shutdown()` is not reachable and
  // this is the ONLY thing that can flush.
  //
  // Deliberately no process.exit() here, unlike the signal handlers — returning
  // lets Node exit on its own once the flush settles. Awaiting inside
  // 'beforeExit' revives the event loop, so the event can fire again; the
  // `fired` guard in run() makes the second pass a no-op.
  const beforeExitHandler = (): void => {
    void run();
  };
  process.once('beforeExit', beforeExitHandler);

  return {
    async shutdown(): Promise<void> {
      for (const [sig, handler] of signalHandlers) {
        process.removeListener(sig, handler);
      }
      process.removeListener('beforeExit', beforeExitHandler);
      await run();
    },
  };
}
