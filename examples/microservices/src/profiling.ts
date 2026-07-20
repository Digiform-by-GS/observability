/**
 * Continuous profiling — opt-in via `PYROSCOPE_SERVER_ADDRESS`.
 *
 * This is the piece that answers "which *function* is allocating the memory?".
 * Metrics can't: `v8js_memory_heap_used_bytes` is a per-process gauge labelled
 * by V8 heap space, with no function, request or trace attached. Traces can't
 * either: a span measures elapsed time, not allocation. Only a profiler samples
 * the call stack at allocation time.
 *
 * Loaded dynamically and best-effort on purpose: `@pyroscope/nodejs` pulls in a
 * native module (`@datadog/pprof`), and a missing prebuild must never take a
 * service down — profiling is a diagnostic, not a dependency.
 */
export async function startProfiling(serviceName: string): Promise<void> {
  const serverAddress = process.env.PYROSCOPE_SERVER_ADDRESS;
  if (!serverAddress) return;

  try {
    const { default: Pyroscope } = await import('@pyroscope/nodejs');

    Pyroscope.init({
      serverAddress,
      appName: serviceName,
      // Tags become Pyroscope label filters. Keep them aligned with the OTel
      // resource attributes so the same words work across all four signals.
      tags: {
        service_name: serviceName,
        environment:
          process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
      },
    });

    // Starts wall-clock (where time goes) and heap (where allocations happen).
    Pyroscope.start();
    console.log(`[profiling] pyroscope started: ${serviceName} -> ${serverAddress}`);
  } catch (err) {
    const first = (err as Error).message.split('\n')[0];
    console.warn(`[profiling] disabled for ${serviceName}: ${first}`);
    if (process.env.ELECTRON_RUN_AS_NODE) {
      // node-gyp-build treats ELECTRON_RUN_AS_NODE as "this is Electron" and
      // looks for an Electron prebuild that doesn't exist. VS Code's integrated
      // terminal sets it. Run with `env -u ELECTRON_RUN_AS_NODE ...`.
      console.warn('[profiling] ELECTRON_RUN_AS_NODE is set — unset it to load the native profiler.');
    }
  }
}
