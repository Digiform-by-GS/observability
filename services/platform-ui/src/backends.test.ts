import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePromInstant } from './backends.js';

test('parses a successful instant query', () => {
  const r = parsePromInstant(JSON.stringify({
    status: 'success',
    data: { resultType: 'vector', result: [
      { metric: { service: 'a', team: 't' }, value: [1700000000, '2.5'] },
    ] },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.samples.length, 1);
  assert.equal(r.samples[0]?.value, 2.5);
  assert.equal(r.samples[0]?.metric.service, 'a');
});

test('surfaces an error status instead of pretending the result is empty', () => {
  const r = parsePromInstant(JSON.stringify({ status: 'error', error: 'parse error' }));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /parse error/);
});

test('non-JSON is an error, not a crash', () => {
  const r = parsePromInstant('<html>502 Bad Gateway</html>');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /not JSON/);
});

// Prometheus encodes stale/absent samples as NaN. Carrying that through as 0
// would render "no data at all" as "running and idle" - operationally different.
test('drops NaN samples rather than reporting them as zero', () => {
  const r = parsePromInstant(JSON.stringify({
    status: 'success',
    data: { result: [
      { metric: { service: 'good' }, value: [1, '1'] },
      { metric: { service: 'stale' }, value: [1, 'NaN'] },
    ] },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.samples.map((s) => s.metric.service), ['good']);
});

test('an empty result set is success, not failure', () => {
  const r = parsePromInstant(JSON.stringify({ status: 'success', data: { result: [] } }));
  assert.equal(r.ok, true);
  assert.equal(r.samples.length, 0);
});
