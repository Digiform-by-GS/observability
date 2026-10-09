import type { Backends, QueryResult, Sample } from './backends.js';

/**
 * The service catalogue: every service the platform has heard from, with its RED
 * numbers and which signals it is actually sending.
 *
 * Signal coverage is the part worth having. A service that sends traces but no
 * logs renders as perfectly healthy on every RED dashboard, because those are
 * built from spans — the absence is invisible exactly where someone would look
 * for it. Showing both columns side by side is the whole point of this page.
 */

export interface ServiceRow {
  service: string;
  team: string;
  environment: string;
  /** req/s. null means no span-metrics at all, which is not the same as 0. */
  requestRate: number | null;
  /** Fraction 0..1, null when there is no traffic to divide by. */
  errorRatio: number | null;
  /** Seconds. */
  latencyP95: number | null;
  sendingTraces: boolean;
  sendingLogs: boolean;
}

export interface Catalog {
  services: ServiceRow[];
  /** Per-backend health, so the page can say WHICH part is degraded. */
  degraded: string[];
  rangeSeconds: number;
}

/** Mimir label for span-metrics is `service`; Loki's is `service_name`. */
const SVC = 'service';

function keyOf(m: Record<string, string>): string {
  return [m[SVC] ?? '', m.team ?? '', m.deployment_environment ?? ''].join('\u0000');
}

function index(r: QueryResult): Map<string, Sample> {
  const out = new Map<string, Sample>();
  if (!r.ok) return out;
  for (const s of r.samples) out.set(keyOf(s.metric), s);
  return out;
}

export function buildCatalog(
  rate: QueryResult,
  errors: QueryResult,
  latency: QueryResult,
  logs: QueryResult,
  rangeSeconds: number,
): Catalog {
  const errIdx = index(errors);
  const latIdx = index(latency);

  // Loki keys on service_name and carries no team/environment, so log presence
  // is matched on the service name alone. A service deployed to two environments
  // therefore shows "sending logs" on both rows if either logs. Accepted: the
  // column answers "is this service wired for logs at all", and claiming a
  // per-environment precision the data does not support would be worse.
  const logNames = new Set<string>();
  if (logs.ok) {
    for (const s of logs.samples) {
      const n = s.metric.service_name;
      if (n && s.value > 0) logNames.add(n);
    }
  }

  const rows: ServiceRow[] = [];
  for (const s of rate.ok ? rate.samples : []) {
    const name = s.metric[SVC];
    if (!name) continue;
    const k = keyOf(s.metric);
    const err = errIdx.get(k)?.value ?? null;
    const lat = latIdx.get(k)?.value ?? null;
    rows.push({
      service: name,
      team: s.metric.team ?? 'unattributed',
      environment: s.metric.deployment_environment ?? 'unknown',
      requestRate: s.value,
      errorRatio: err !== null && s.value > 0 ? err / s.value : err !== null ? 0 : null,
      latencyP95: lat !== null && Number.isFinite(lat) ? lat : null,
      sendingTraces: s.value > 0,
      sendingLogs: logNames.has(name),
    });
  }

  rows.sort((a, b) =>
    a.team.localeCompare(b.team) || a.service.localeCompare(b.service) ||
    a.environment.localeCompare(b.environment));

  const degraded: string[] = [];
  if (!rate.ok) degraded.push(`metrics: ${rate.error ?? 'unavailable'}`);
  if (!logs.ok) degraded.push(`logs: ${logs.error ?? 'unavailable'}`);

  return { services: rows, degraded, rangeSeconds };
}

/**
 * The same expressions the Service Inventory dashboard uses. Deliberately
 * copied rather than invented: two sources of truth for "what counts as a
 * service" is how a UI and its dashboards start disagreeing.
 */
export async function fetchCatalog(b: Backends, rangeSeconds = 3600): Promise<Catalog> {
  const w = `${rangeSeconds}s`;
  const [rate, errors, latency, logs] = await Promise.all([
    b.promInstant(`sum by (${SVC}, team, deployment_environment) (rate(traces_spanmetrics_calls_total[${w}]))`),
    b.promInstant(
      `sum by (${SVC}, team, deployment_environment) ` +
      `(rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[${w}]))`),
    b.promInstant(
      `histogram_quantile(0.95, sum by (le, ${SVC}, team, deployment_environment) ` +
      `(rate(traces_spanmetrics_latency_bucket[${w}])))`),
    b.logServices(rangeSeconds),
  ]);
  return buildCatalog(rate, errors, latency, logs, rangeSeconds);
}
