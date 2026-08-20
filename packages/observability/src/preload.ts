import { registerEsmHook } from './esm-hook.js';
import { initObservability } from './init.js';

// Side-effect-only entry point for `node --import @digiform-by-gs/observability/preload`.
// Relies entirely on env vars (OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, …).
//
// The hook goes first and it must stay first: it has to be in place before the
// service imports express/pg/redis, or those modules load unpatched and their
// instrumentation silently does nothing. See esm-hook.ts for the full symptom.
registerEsmHook();
initObservability();
