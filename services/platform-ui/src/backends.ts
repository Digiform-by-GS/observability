/**
 * Thin query clients for Mimir (PromQL) and Loki (LogQL).
 *
 * Queried directly rather than through Grafana's proxy. Grafana's /api/ds/query
 * needs an authenticated session and speaks a datasource-specific envelope that
 * changes between versions; the backends' own APIs are stable and public. The
 * cost is that the tenant header has to be set here, which is the one thing a
 * caller must not get wrong — see Config.tenants.
 */

export interface Sample {
  metric: Record<string, string>;
  value: number;
}

/** A backend being down must degrade one column, never fail the page. */
export interface QueryResult {
  ok: boolean;
  samples: Sample[];
  /** Present when ok is false. Shown to the operator, not swallowed. */
  error?: string;
}

export const EMPTY: QueryResult = { ok: false, samples: [], error: 'not queried' };

/**
 * Parses Prometheus' instant-query envelope.
 *
 * Separated from the fetch so it can be tested without a server, which is the
 * idiom the onboarding-agent uses for the same reason.
 *
 * A NaN value is dropped rather than surfaced as 0: Prometheus encodes stale or
 * absent samples that way, and 0 req/s reads as "running and idle" when the
 * truth is "no data at all". Those are different operationally.
 */
export function parsePromInstant(text: string): QueryResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, samples: [], error: 'response was not JSON' };
  }
  const d = doc as { status?: string; error?: string; data?: { result?: unknown[] } };
  if (d.status !== 'success') {
    return { ok: false, samples: [], error: d.error ?? `status=${String(d.status)}` };
  }
  const rows = Array.isArray(d.data?.result) ? d.data.result : [];
  const samples: Sample[] = [];
  for (const row of rows) {
    const r = row as { metric?: Record<string, string>; value?: [number, string] };
    const raw = r.value?.[1];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    samples.push({ metric: r.metric ?? {}, value: n });
  }
  return { ok: true, samples };
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export interface Backends {
  promInstant(query: string): Promise<QueryResult>;
  logServices(rangeSeconds: number): Promise<QueryResult>;
}

export function createBackends(opts: {
  mimirUrl: string;
  lokiUrl: string;
  tenants: string;
  timeoutMs: number;
}): Backends {
  const headers = { 'X-Scope-OrgID': opts.tenants, accept: 'application/json' };

  return {
    async promInstant(query: string): Promise<QueryResult> {
      const url = `${opts.mimirUrl}/prometheus/api/v1/query?query=${encodeURIComponent(query)}`;
      try {
        return parsePromInstant(await getJson(url, headers, opts.timeoutMs));
      } catch (err) {
        return { ok: false, samples: [], error: err instanceof Error ? err.message : String(err) };
      }
    },

    /**
     * Which services have sent LOGS in the window.
     *
     * Loki, not Mimir, and `service_name` rather than `service` — the two systems
     * genuinely label this differently, and querying Mimir's spelling here
     * returns an empty set that reads as "nobody is logging".
     */
    async logServices(rangeSeconds: number): Promise<QueryResult> {
      if (!opts.lokiUrl) return { ok: false, samples: [], error: 'LOKI_URL not set' };
      const q = `sum by (service_name) (count_over_time({service_name=~".+"}[${rangeSeconds}s]))`;
      const url = `${opts.lokiUrl}/loki/api/v1/query?query=${encodeURIComponent(q)}`;
      try {
        return parsePromInstant(await getJson(url, headers, opts.timeoutMs));
      } catch (err) {
        return { ok: false, samples: [], error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
