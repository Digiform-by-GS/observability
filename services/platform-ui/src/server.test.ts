import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from './server.js';
import type { Config } from './config.js';
import type { Backends, QueryResult } from './backends.js';

/**
 * Drives the real Express routes against a stub, so the wiring is covered and
 * not just the pure helpers. The modules below are unit-tested in isolation;
 * what this file catches is the class of bug those cannot: a route that never
 * calls them, a query parameter that is dropped, a response shape the page's
 * JavaScript does not expect.
 */

const cfg: Config = {
  port: 0,
  mimirUrl: 'http://mimir:9009',
  lokiUrl: 'http://loki:3100',
  grafanaUrl: 'https://grafana.example.com',
  tenants: 'a|b',
  teamsFile: '/nonexistent/teams.json',
  requestTimeoutMs: 1000,
};

const sample = (metric: Record<string, string>, value: number) => ({ metric, value });
const okResult = (samples: ReturnType<typeof sample>[]): QueryResult => ({ ok: true, samples });

let lastQueries: string[] = [];

const stub: Backends = {
  async promInstant(query: string) {
    lastQueries.push(query);
    if (query.includes('STATUS_CODE_ERROR')) {
      return okResult([sample({ service: 'api', team: 'g', deployment_environment: 'dev' }, 0.5)]);
    }
    if (query.includes('histogram_quantile')) {
      return okResult([sample({ service: 'api', team: 'g', deployment_environment: 'dev' }, 0.3)]);
    }
    return okResult([sample({ service: 'api', team: 'g', deployment_environment: 'dev' }, 5)]);
  },
  async logServices() {
    return okResult([sample({ service_name: 'api' }, 12)]);
  },
};

let server: Server;
let base: string;

before(async () => {
  server = createApp(cfg, stub).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server.close(); });

test('healthz responds', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('the catalogue joins all four queries into one row', async () => {
  const r = await fetch(`${base}/api/catalog`);
  assert.equal(r.status, 200);
  const body = await r.json() as { services: Array<Record<string, unknown>>; rangeSeconds: number };
  assert.equal(body.services.length, 1);
  assert.equal(body.services[0]?.service, 'api');
  assert.equal(body.services[0]?.requestRate, 5);
  assert.equal(body.services[0]?.errorRatio, 0.1);
  assert.equal(body.services[0]?.sendingLogs, true);
  assert.equal(body.rangeSeconds, 3600);
});

// The window is interpolated into PromQL. An allow-list, not a clamp, is what
// keeps that from being a way to smuggle anything through the parameter.
test('an unknown range falls back to the default rather than reaching PromQL', async () => {
  lastQueries = [];
  const r = await fetch(`${base}/api/catalog?range=1h%5D)%20or%20vector(1)%20%23`);
  const body = await r.json() as { rangeSeconds: number };
  assert.equal(body.rangeSeconds, 3600);
  assert.ok(lastQueries.every((q) => q.includes('[3600s]')), lastQueries[0]);
  assert.ok(!lastQueries.some((q) => q.includes('vector(1)')));
});

test('an allowed range is honoured', async () => {
  lastQueries = [];
  await fetch(`${base}/api/catalog?range=86400`);
  assert.ok(lastQueries.every((q) => q.includes('[86400s]')), lastQueries[0]);
});

test('panels come back as ready-made embed urls carrying the service', async () => {
  const r = await fetch(`${base}/api/panels?service=api&team=g&environment=dev`);
  const body = await r.json() as {
    panels: Array<{ title: string; src: string }>;
    links: { overview: string; inventory: string; appMetrics: string; rum: string };
  };
  assert.equal(body.panels.length, 4);
  const u = new URL(body.panels[0]!.src);
  assert.equal(u.origin, 'https://grafana.example.com');
  assert.equal(u.pathname, '/d-solo/observability-overview/panel');
  assert.equal(u.searchParams.get('var-service'), 'api');
  assert.equal(u.searchParams.get('panelId'), '1');
  assert.ok(body.links.overview.includes('/d/observability-overview'));
});

test('a bogus from= is replaced rather than passed through to Grafana', async () => {
  const r = await fetch(`${base}/api/panels?service=api&from=javascript:alert(1)`);
  const body = await r.json() as { panels: Array<{ src: string }> };
  assert.equal(new URL(body.panels[0]!.src).searchParams.get('from'), 'now-30m');
});

// The page must still render when the team file is absent - it is a nicety,
// and each service row already carries its own team.
test('a missing teams file degrades to an empty list, not a 500', async () => {
  const r = await fetch(`${base}/api/teams`);
  assert.equal(r.status, 200);
  const body = await r.json() as { available: boolean };
  assert.equal(body.available, false);
});

test('the page itself is served', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Observability Platform/);
  assert.match(html, /api\/catalog/);
});

test('config exposes the browser-facing Grafana url and the panel list', async () => {
  const body = await (await fetch(`${base}/api/config`)).json() as
    { grafanaUrl: string; panels: unknown[] };
  assert.equal(body.grafanaUrl, 'https://grafana.example.com');
  assert.equal(body.panels.length, 4);
});
