import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelEmbedUrl, dashboardUrl, OVERVIEW_PANELS } from './embeds.js';

const panel = OVERVIEW_PANELS[0]!;

test('builds a /d-solo/ url with the panel id and vars', () => {
  const u = new URL(panelEmbedUrl({
    grafanaUrl: 'https://grafana.example.com',
    panel,
    vars: { service: 'costwise-backend', team: 'gudangsolusi' },
  }));
  assert.equal(u.pathname, '/d-solo/observability-overview/panel');
  assert.equal(u.searchParams.get('panelId'), '1');
  assert.equal(u.searchParams.get('var-service'), 'costwise-backend');
  assert.equal(u.searchParams.get('var-team'), 'gudangsolusi');
  assert.equal(u.searchParams.get('orgId'), '1');
});

test('a trailing slash on the base url does not double up', () => {
  const u = panelEmbedUrl({ grafanaUrl: 'https://g.example.com///', panel, vars: {} });
  assert.ok(u.startsWith('https://g.example.com/d-solo/'), u);
});

// A service name with a slash or space produced a URL that silently resolved to
// a different (or no) series, which renders as an empty panel rather than an error.
test('variable values are encoded', () => {
  const u = new URL(panelEmbedUrl({
    grafanaUrl: 'https://g.example.com', panel, vars: { service: 'a b/c&d' },
  }));
  assert.equal(u.searchParams.get('var-service'), 'a b/c&d');
});

test('empty variables are omitted so Grafana falls back to its own default', () => {
  const u = new URL(panelEmbedUrl({
    grafanaUrl: 'https://g.example.com', panel, vars: { service: 'x', team: '' },
  }));
  assert.equal(u.searchParams.get('var-service'), 'x');
  assert.equal(u.searchParams.has('var-team'), false);
});

test('var order is deterministic regardless of insertion order', () => {
  const a = panelEmbedUrl({ grafanaUrl: 'https://g', panel, vars: { b: '2', a: '1' } });
  const b = panelEmbedUrl({ grafanaUrl: 'https://g', panel, vars: { a: '1', b: '2' } });
  assert.equal(a, b);
});

test('dashboard links use /d/ rather than /d-solo/', () => {
  const u = new URL(dashboardUrl('https://g.example.com', 'service-inventory', { team: 't' }));
  assert.ok(u.pathname.startsWith('/d/'), u.pathname);
  assert.equal(u.searchParams.get('var-team'), 't');
});

test('every embedded panel has a distinct id on its dashboard', () => {
  const seen = new Set(OVERVIEW_PANELS.map((p) => `${p.uid}#${p.panelId}`));
  assert.equal(seen.size, OVERVIEW_PANELS.length);
});
