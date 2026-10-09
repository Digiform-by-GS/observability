import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from './catalog.js';
import type { QueryResult } from './backends.js';

const ok = (rows: Array<[Record<string, string>, number]>): QueryResult =>
  ({ ok: true, samples: rows.map(([metric, value]) => ({ metric, value })) });
const down = (msg: string): QueryResult => ({ ok: false, samples: [], error: msg });

const svc = (s: string, t = 'gudangsolusi', e = 'shared-dev') =>
  ({ service: s, team: t, deployment_environment: e });

test('joins rate, errors and latency onto one row per service', () => {
  const c = buildCatalog(
    ok([[svc('api'), 10]]),
    ok([[svc('api'), 1]]),
    ok([[svc('api'), 0.25]]),
    ok([[{ service_name: 'api' }, 5]]),
    3600,
  );
  assert.equal(c.services.length, 1);
  const r = c.services[0]!;
  assert.equal(r.service, 'api');
  assert.equal(r.requestRate, 10);
  assert.equal(r.errorRatio, 0.1);
  assert.equal(r.latencyP95, 0.25);
  assert.equal(r.sendingTraces, true);
  assert.equal(r.sendingLogs, true);
});

// The reason this page exists: traces present, logs absent renders as perfectly
// healthy on every RED dashboard, because those are built from spans.
test('a service sending traces but no logs is reported as such', () => {
  const c = buildCatalog(ok([[svc('quiet'), 3]]), ok([]), ok([]), ok([]), 3600);
  assert.equal(c.services[0]?.sendingTraces, true);
  assert.equal(c.services[0]?.sendingLogs, false);
});

test('Loki matches on service_name, not service', () => {
  const c = buildCatalog(
    ok([[svc('api'), 1]]), ok([]), ok([]),
    ok([[{ service: 'api' }, 9]]),   // wrong label on purpose
    3600,
  );
  assert.equal(c.services[0]?.sendingLogs, false);
});

test('missing latency is null rather than zero', () => {
  const c = buildCatalog(ok([[svc('api'), 1]]), ok([]), ok([]), ok([]), 3600);
  assert.equal(c.services[0]?.latencyP95, null);
});

test('error ratio is null when there is no traffic to divide by', () => {
  const c = buildCatalog(ok([[svc('api'), 0]]), ok([]), ok([]), ok([]), 3600);
  assert.equal(c.services[0]?.errorRatio, null);
});

test('the same service in two environments stays two rows', () => {
  const c = buildCatalog(
    ok([[svc('api', 'g', 'dev'), 1], [svc('api', 'g', 'prod'), 2]]),
    ok([]), ok([]), ok([]), 3600,
  );
  assert.equal(c.services.length, 2);
  assert.deepEqual(c.services.map((r) => r.environment), ['dev', 'prod']);
});

// A degraded backend must narrow the page, not blank it.
test('Loki being down still lists services, and says so', () => {
  const c = buildCatalog(ok([[svc('api'), 1]]), ok([]), ok([]), down('connect ECONNREFUSED'), 3600);
  assert.equal(c.services.length, 1);
  assert.equal(c.services[0]?.sendingLogs, false);
  assert.ok(c.degraded.some((d) => d.includes('logs')), c.degraded.join(','));
});

test('Mimir being down yields no rows and an explicit reason', () => {
  const c = buildCatalog(down('HTTP 503'), ok([]), ok([]), ok([]), 3600);
  assert.equal(c.services.length, 0);
  assert.ok(c.degraded.some((d) => d.includes('metrics')));
});

test('a sample with no service label is skipped rather than rendered blank', () => {
  const c = buildCatalog(ok([[{ team: 'g' }, 5], [svc('real'), 1]]), ok([]), ok([]), ok([]), 3600);
  assert.deepEqual(c.services.map((r) => r.service), ['real']);
});

test('rows are sorted by team then service then environment', () => {
  const c = buildCatalog(
    ok([[svc('z', 'b'), 1], [svc('a', 'b'), 1], [svc('m', 'a'), 1]]),
    ok([]), ok([]), ok([]), 3600,
  );
  assert.deepEqual(c.services.map((r) => `${r.team}/${r.service}`), ['a/m', 'b/a', 'b/z']);
});
