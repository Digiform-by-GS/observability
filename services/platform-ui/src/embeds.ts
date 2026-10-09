/**
 * Grafana embed URLs.
 *
 * Built and unit-tested here rather than assembled in the page's JavaScript,
 * because an embed fails *silently*: a wrong panelId renders an empty panel, a
 * missing var renders "All", and a typo'd uid renders Grafana's "dashboard not
 * found" page inside the frame. None of those throw, so none of them show up
 * as an error anywhere — only as a page that looks subtly wrong.
 */

export interface PanelRef {
  /** Dashboard uid, as provisioned. */
  uid: string;
  /** Panel id. Stable only because gen-dashboards.py now assigns them. */
  panelId: number;
  title: string;
  /** Short note rendered under the panel, so the UI explains itself. */
  note?: string;
}

/**
 * The panels this UI embeds, from `default.json` (uid observability-overview).
 *
 * That dashboard is hand-written and has carried ids 1-4 all along, which is
 * why these four were embeddable before anything was generated. Its template
 * variables are team / service / environment — note `environment`, while the
 * underlying label is `deployment_environment`.
 */
export const OVERVIEW_PANELS: PanelRef[] = [
  { uid: 'observability-overview', panelId: 1, title: 'Request rate' },
  { uid: 'observability-overview', panelId: 2, title: 'Error rate' },
  {
    uid: 'observability-overview', panelId: 3, title: 'p95 latency',
    note: 'Derived from spans, so it reflects what the client sampled.',
  },
  { uid: 'observability-overview', panelId: 4, title: 'Logs' },
];

export interface EmbedOptions {
  grafanaUrl: string;
  panel: PanelRef;
  vars: Record<string, string>;
  from?: string;
  to?: string;
  theme?: 'light' | 'dark';
}

/**
 * `/d-solo/` renders one panel with no chrome — the endpoint intended for
 * iframes. The slug segment is cosmetic (Grafana resolves by uid) but must be
 * present, or the path shape is wrong and Grafana 404s.
 */
export function panelEmbedUrl(o: EmbedOptions): string {
  const base = o.grafanaUrl.replace(/\/+$/, '');
  const p = new URLSearchParams();
  p.set('orgId', '1');
  p.set('panelId', String(o.panel.panelId));
  p.set('from', o.from ?? 'now-30m');
  p.set('to', o.to ?? 'now');
  p.set('theme', o.theme ?? 'dark');
  // Sorted so the URL is deterministic, which makes it diffable in tests and
  // cacheable by the browser across renders of the same view.
  for (const k of Object.keys(o.vars).sort()) {
    const v = o.vars[k];
    if (v !== undefined && v !== '') p.set(`var-${k}`, v);
  }
  return `${base}/d-solo/${encodeURIComponent(o.panel.uid)}/panel?${p.toString()}`;
}

/** Full-dashboard link, for "open this in Grafana" rather than an iframe. */
export function dashboardUrl(grafanaUrl: string, uid: string, vars: Record<string, string>): string {
  const base = grafanaUrl.replace(/\/+$/, '');
  const p = new URLSearchParams({ orgId: '1' });
  for (const k of Object.keys(vars).sort()) {
    const v = vars[k];
    if (v !== undefined && v !== '') p.set(`var-${k}`, v);
  }
  return `${base}/d/${encodeURIComponent(uid)}/dashboard?${p.toString()}`;
}
