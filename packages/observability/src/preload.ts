import { initObservability } from './init.js';

// Side-effect-only entry point for `node --import @digiform-by-gs/observability/preload`
// (ESM) or `node --require @digiform-by-gs/observability/preload` (CJS). Relies entirely
// on env vars (OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, etc.) for config.
initObservability();
