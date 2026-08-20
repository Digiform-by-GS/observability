import { register } from 'node:module';

const GLOBAL_HOOK_KEY = '__digiform_observability_esm_hook__';
type GlobalWithHook = typeof globalThis & { [GLOBAL_HOOK_KEY]?: boolean };

/**
 * Registers OpenTelemetry's ESM loader hook.
 *
 * Without this, instrumentation for userland packages silently does nothing in
 * an ESM service. Core modules still work — OTel patches those through the
 * require hook, which is why `http` spans appear and everything looks fine —
 * but Express, Fastify, pg, ioredis and the rest are never patched. The visible
 * symptom is server spans named after the bare method (`GET`, `POST`) with no
 * `http.route` attribute, so every endpoint collapses into one metric series
 * and per-route RED metrics do not exist. Nothing errors.
 *
 * Diagnosed by running with OTEL_LOG_LEVEL=debug: `instrumentation-http` and
 * `instrumentation-net` log "Applying instrumentation patch", and
 * `instrumentation-express` never does. With this hook registered, it does.
 *
 * `register()` needs Node >= 18.19 / >= 20.6, which is exactly this package's
 * `engines` floor, so it is always available in a supported runtime. It is
 * still guarded: a hook failure must degrade to "core-module instrumentation
 * only", never to a service that refuses to boot.
 */
export function registerEsmHook(): void {
  const g = globalThis as GlobalWithHook;
  // Registering twice would stack loader hooks on double-init.
  if (g[GLOBAL_HOOK_KEY]) return;

  try {
    register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
    g[GLOBAL_HOOK_KEY] = true;
  } catch (err) {
    console.warn(
      '[@digiform-by-gs/observability] could not register the ESM loader hook; ' +
        'instrumentation for non-core modules (express, pg, redis, …) will be inactive. ' +
        'Traces and logs still work.',
      err,
    );
  }
}
