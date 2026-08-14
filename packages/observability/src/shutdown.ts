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

  return {
    async shutdown(): Promise<void> {
      for (const [sig, handler] of signalHandlers) {
        process.removeListener(sig, handler);
      }
      await run();
    },
  };
}
