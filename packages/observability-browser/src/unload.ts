/**
 * Flush-on-hide.
 *
 * Batch processors hold spans in memory until a timer fires. On a server that
 * is harmless — the process outlives the batch. In a browser the page can be
 * destroyed at any moment, taking the queue with it, and the telemetry most
 * worth having is exactly what happened just before someone navigated away. A
 * batching browser SDK with no unload flush reports the boring middle of a
 * session and loses the end.
 *
 * `visibilitychange` → hidden is the signal to use. `unload` and
 * `beforeunload` are unreliable (they do not fire on mobile task-switch, and
 * registering them disables the back/forward cache), while `pagehide` misses
 * the case where a user switches tabs and never returns. Listening for both
 * hidden-visibility and pagehide covers the real paths; `flushed` guards
 * against doing the work twice when both fire.
 */
export function registerUnloadFlush(flush: () => void): () => void {
  let flushing = false;

  const run = (): void => {
    if (flushing) return;
    flushing = true;
    try {
      flush();
    } finally {
      // Cleared on a microtask so a pagehide immediately after a
      // visibilitychange is suppressed, but a later genuine hide still flushes.
      queueMicrotask(() => {
        flushing = false;
      });
    }
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') run();
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', run);

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', run);
  };
}
