import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoUrl, requestNoun } from './providers.js';

function ok(url: string, opts = {}) {
  const r = parseRepoUrl(url, opts);
  assert.equal(r.ok, true, `expected ${url} to parse, got: ${r.ok ? '' : r.error}`);
  return r.ok ? r.repo : (undefined as never);
}
function bad(url: string, opts = {}) {
  const r = parseRepoUrl(url, opts);
  assert.equal(r.ok, false, `expected ${url} to be rejected`);
  return r.ok ? (undefined as never) : r.error;
}

test('detects github and gitlab from the host', () => {
  assert.equal(ok('https://github.com/acme/orders').provider, 'github');
  assert.equal(ok('https://gitlab.com/acme/orders').provider, 'gitlab');
});

test('supports gitlab subgroups, which github paths never have', () => {
  const r = ok('https://gitlab.com/acme/backend/payments');
  assert.equal(r.path, 'acme/backend/payments');
  assert.equal(r.provider, 'gitlab');
});

test('normalises .git suffixes and trailing slashes', () => {
  assert.equal(ok('https://github.com/acme/orders.git').url, 'https://github.com/acme/orders');
  assert.equal(ok('https://gitlab.com/acme/orders/').url, 'https://gitlab.com/acme/orders');
});

test('self-hosted gitlab works via the configured host list', () => {
  const opts = { gitlabHosts: ['git.acme.co.id'] };
  assert.equal(ok('https://git.acme.co.id/team/api', opts).provider, 'gitlab');
});

test('an unknown host is refused unless the provider is stated', () => {
  const err = bad('https://git.acme.co.id/team/api');
  assert.match(err, /cannot tell which provider/);
  assert.equal(ok('https://git.acme.co.id/team/api', { provider: 'gitlab' }).provider, 'gitlab');
});

// The SSRF guard. Accepting self-hosted hosts means accepting arbitrary ones,
// so a job submitter must not be able to aim the runner at the platform's own
// backends or at cloud metadata.
test('refuses loopback, private ranges, and metadata addresses', () => {
  for (const host of [
    'https://localhost/a/b',
    'https://127.0.0.1/a/b',
    'https://10.0.0.5/a/b',
    'https://192.168.0.10/a/b',
    'https://172.16.4.4/a/b',
    'https://169.254.169.254/a/b',
    'https://metadata.google.internal/a/b',
    'https://gitlab.internal/a/b',
  ]) {
    const err = bad(host, { provider: 'gitlab' });
    assert.match(err, /blocked|internal|loopback/i, `${host} should be blocked, got: ${err}`);
  }
});

// 20.x is public Azure space, not RFC1918, so the private-range rule does not
// cover the platform's own address; the server passes it in explicitly.
test('the platform host itself is refused even with provider stated', () => {
  const opts = { provider: 'gitlab', blockedHosts: ['20.20.1.88'] };
  assert.match(bad('https://20.20.1.88/a/b', opts), /this platform's own address/);
  // and is still fine as a repo host when it is not the platform
  assert.equal(parseRepoUrl('https://20.20.1.88/a/b', { provider: 'gitlab' }).ok, true);
});

test('rejects non-https and embedded credentials', () => {
  assert.match(bad('http://github.com/acme/orders'), /https/);
  assert.match(bad('https://user:tok@github.com/acme/orders'), /credentials/);
});

test('rejects paths that are not a project', () => {
  assert.match(bad('https://github.com/acme'), /project path/);
  assert.match(bad('https://github.com/'), /project path/);
});

test('names the request correctly per provider', () => {
  assert.equal(requestNoun('gitlab'), 'merge request');
  assert.equal(requestNoun('github'), 'pull request');
});
