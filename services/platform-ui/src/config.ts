/**
 * Configuration, read once at startup.
 *
 * Two of these are addresses the BROWSER must reach, not addresses this process
 * must reach, and conflating them is the mistake that makes an embed work on the
 * server and show nothing to a user: `grafanaUrl` ends up in an <iframe src>, so
 * `http://grafana:3000` resolves only inside the Docker network. The Mimir and
 * Loki URLs are the opposite — queried server-side, so container names are
 * correct there and a public address would route platform-internal queries out
 * over the internet.
 */
export interface Config {
  port: number;
  /** Server-side. Container DNS is correct here. */
  mimirUrl: string;
  /** Server-side. Empty disables the log-coverage column rather than failing. */
  lokiUrl: string;
  /** BROWSER-side: embedded in iframe URLs the user's browser loads. */
  grafanaUrl: string;
  /**
   * Mimir is multi-tenant and a query carries one X-Scope-OrgID. Mimir accepts a
   * pipe-separated list to read across tenants, which is exactly what Grafana's
   * provisioned datasource does. Kept configurable because the set of tenants is
   * generated from infra/tenants.yaml and will grow.
   */
  tenants: string;
  /** Where the generated team list is mounted. */
  teamsFile: string;
  requestTimeoutMs: number;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Trailing slashes break URL joining in ways that 404 silently. */
function trimUrl(v: string): string {
  return v.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const grafanaUrl = trimUrl(env.GRAFANA_URL ?? '');
  if (!grafanaUrl) {
    // Fail at startup rather than serving a page whose every panel is a broken
    // iframe — that failure looks like Grafana is down, not like missing config.
    throw new Error('GRAFANA_URL is required (the address a BROWSER uses, e.g. https://grafana.example.com)');
  }
  return {
    port: int('PORT', 8200),
    mimirUrl: trimUrl(env.MIMIR_URL ?? 'http://mimir:9009'),
    lokiUrl: trimUrl(env.LOKI_URL ?? 'http://loki:3100'),
    grafanaUrl,
    tenants: env.MIMIR_TENANTS ?? 'platform|unattributed|gudangsolusi|anonymous',
    teamsFile: env.TEAMS_FILE ?? '/etc/platform/teams.json',
    requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 10_000),
  };
}
