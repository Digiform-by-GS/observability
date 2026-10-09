import express from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { createBackends, type Backends } from './backends.js';
import { fetchCatalog } from './catalog.js';
import { OVERVIEW_PANELS, panelEmbedUrl, dashboardUrl } from './embeds.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Built as a function of its config and backends rather than reading the
 * environment at import time, so server.test.ts can drive the real routes
 * against a stub without binding a port or setting process.env.
 */
export function createApp(cfg: Config, backends: Backends) {
const app = express();
app.disable('x-powered-by');

/**
 * Read-only and unauthenticated, matching Grafana's anonymous Viewer on this
 * platform: a UI that is harder to open than the dashboards it links to would
 * just be bypassed. It exposes no credential and performs no write — the one
 * thing it must never become is a proxy that forwards arbitrary PromQL, which
 * is why the queries below are fixed and only the window is a parameter.
 */
app.get('/healthz', (_req, res) => res.json({ ok: true }));

/** The browser needs Grafana's PUBLIC address to load an iframe; it is not a secret. */
app.get('/api/config', (_req, res) => {
  res.json({ grafanaUrl: cfg.grafanaUrl, panels: OVERVIEW_PANELS });
});

app.get('/api/teams', (_req, res) => {
  try {
    const doc = JSON.parse(readFileSync(cfg.teamsFile, 'utf8')) as unknown;
    res.json(doc);
  } catch {
    // The team list is a nicety here - the catalogue already reports each
    // service's team. Degrade to empty rather than failing the page.
    res.json({ teams: [], catchAll: 'unattributed', available: false });
  }
});

const RANGES = new Set([900, 3600, 21600, 86400]);

app.get('/api/catalog', async (req, res) => {
  const raw = Number(req.query.range);
  // Allow-list rather than clamp: the value is interpolated into PromQL, and a
  // fixed set cannot be used to smuggle anything through the window parameter.
  const range = RANGES.has(raw) ? raw : 3600;
  try {
    res.json(await fetchCatalog(backends, range));
  } catch (err) {
    res.status(502).json({
      services: [], rangeSeconds: range,
      degraded: [`query failed: ${err instanceof Error ? err.message : String(err)}`],
    });
  }
});

/** Ready-made embed URLs, built by the tested module rather than in page JS. */
app.get('/api/panels', (req, res) => {
  const vars: Record<string, string> = {};
  for (const k of ['service', 'team', 'environment'] as const) {
    const v = req.query[k];
    if (typeof v === 'string' && v !== '') vars[k] = v;
  }
  const theme = req.query.theme === 'light' ? 'light' : 'dark';
  const from = typeof req.query.from === 'string' && /^now-[0-9]+[mhd]$/.test(req.query.from)
    ? req.query.from : 'now-30m';
  res.json({
    panels: OVERVIEW_PANELS.map((panel) => ({
      title: panel.title,
      note: panel.note ?? null,
      src: panelEmbedUrl({ grafanaUrl: cfg.grafanaUrl, panel, vars, theme, from }),
    })),
    links: {
      overview: dashboardUrl(cfg.grafanaUrl, 'observability-overview', vars),
      inventory: dashboardUrl(cfg.grafanaUrl, 'service-inventory', vars),
      appMetrics: dashboardUrl(cfg.grafanaUrl, 'app-metrics', vars),
      rum: dashboardUrl(cfg.grafanaUrl, 'browser-rum', vars),
    },
  });
});

app.use(express.static(join(__dirname, 'public')));
  return app;
}

// Only when run as the entrypoint; importing this module must not bind a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  const backends = createBackends({
    mimirUrl: cfg.mimirUrl,
    lokiUrl: cfg.lokiUrl,
    tenants: cfg.tenants,
    timeoutMs: cfg.requestTimeoutMs,
  });
  createApp(cfg, backends).listen(cfg.port, () => {
    console.log(`[platform-ui] listening on :${cfg.port}`);
    console.log(`[platform-ui] grafana (browser-facing): ${cfg.grafanaUrl}`);
    console.log(`[platform-ui] mimir: ${cfg.mimirUrl}  loki: ${cfg.lokiUrl || '(disabled)'}`);
  });
}
