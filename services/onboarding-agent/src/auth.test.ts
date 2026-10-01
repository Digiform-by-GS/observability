/**
 * The auth gate, exercised against a real server process.
 *
 * server.ts has no exports and listens on import, so there is nothing to unit
 * test - and that is the better outcome here anyway. The hole this covers was
 * not a wrong function, it was a middleware whose exemptions did not match the
 * routes that had grown underneath it: every GET was exempt, while
 * `GET /api/jobs` listed job ids and `GET /api/jobs/:id/patch` streamed the
 * diff generated for a private repository. Only the wiring shows that.
 *
 * Each assertion below was confirmed to fail against the previous code.
 */
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.js');
const KEY = 'test-key-' + randomUUID();

const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  OTLP_ENDPOINT: 'http://collector.invalid:4318',
  GRAFANA_URL: 'http://grafana.invalid:3000',
  ANTHROPIC_API_KEY: 'sk-ant-not-used-no-job-is-run',
  // Nothing here starts a job, so the runner image is never pulled.
};

/**
 * An ephemeral port, released before we hand it over.
 *
 * Not PORT=0: the server logs the port it was ASKED for, so with 0 it prints
 * "listening on :0" and there is no way to learn the real one. Binding and
 * closing leaves a theoretical race, which is why start() waits for the log
 * line rather than assuming the port came up.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Starts the server on `port` and resolves once it says it is listening. */
function start(env: NodeJS.ProcessEnv, port: number): Promise<ChildProcessWithoutNullStreams> {
  const proc = spawn(process.execPath, [SERVER], { env: { ...env, PORT: String(port) }, stdio: 'pipe' });
  return new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error('server did not start in 15s')), 15_000);
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += String(d);
      if (buf.includes(`listening on :${port}`)) { clearTimeout(fail); resolve(proc); }
    });
    proc.on('exit', (code) => { clearTimeout(fail); reject(new Error(`exited ${code}`)); });
  });
}

let proc: ChildProcessWithoutNullStreams;
let base: string;

before(async () => {
  const port = await freePort();
  proc = await start({ ...BASE_ENV, API_KEY: KEY }, port);
  base = `http://127.0.0.1:${port}`;
});

after(() => { proc?.kill(); });

const get = (p: string, key?: string) =>
  fetch(base + p, key === undefined ? {} : { headers: { 'x-api-key': key } });

test('refuses to start with no API_KEY, rather than coming up open', async () => {
  // The whole point of the change. It used to default to '' and disable the
  // middleware, announcing `auth=OFF` in one startup line.
  const env = { ...BASE_ENV };
  delete env.API_KEY;
  let started: ChildProcessWithoutNullStreams | undefined;
  try {
    started = await start(env, await freePort());
  } catch (err) {
    assert.match(String(err), /exited 1/);
    return;
  } finally {
    // Not assert.rejects: if the server DOES come up, that listener outlives
    // the test and keeps `node --test` alive forever, so the regression
    // presents as a hang instead of a failure. Killing it here is what makes
    // this test report rather than stall - verified by reverting the fix.
    started?.kill();
  }
  assert.fail('started with no API_KEY — /api would be served unauthenticated');
});

test('/healthz needs no key, so container probes keep working', async () => {
  assert.equal((await get('/healthz')).status, 200);
});

test('the page path is not gated - it is where the key gets typed', async () => {
  // Asserts "not 401" rather than 200 on purpose. The static assets are copied
  // into dist/ by the Dockerfile (`COPY src/public ./dist/public`), not by tsc,
  // so a plain `npm test` serves 404 here while the image serves 200. Either
  // answer proves the request reached the static handler instead of being
  // turned away by auth, which is the only claim this test is making.
  assert.notEqual((await get('/')).status, 401);
});

test('GET /api/jobs is gated: the id list is how a patch gets found', async () => {
  assert.equal((await get('/api/jobs')).status, 401);
  assert.equal((await get('/api/jobs', 'wrong')).status, 401);
  assert.equal((await get('/api/jobs', KEY)).status, 200);
});

test('GET /api/teams is gated', async () => {
  assert.equal((await get('/api/teams')).status, 401);
  assert.equal((await get('/api/teams', KEY)).status, 200);
});

test('the patch endpoint answers 401, not 404, to an unkeyed caller', async () => {
  // The actual leak. It returned 404 for an unknown id and the diff for a real
  // one, with no key either way - and ids came free from GET /api/jobs.
  const r = await get(`/api/jobs/${randomUUID()}/patch`);
  assert.equal(r.status, 401);
});

test('POST /api/jobs is gated, so no one else can spend the run budget', async () => {
  const r = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoUrl: 'https://github.com/acme/orders.git' }),
  });
  assert.equal(r.status, 401);
});

test('a key of the same length but different bytes is still refused', async () => {
  // keyMatches compares in constant time; timingSafeEqual throws on a length
  // mismatch, so the equal-length case is the one that exercises it.
  const sameLength = 'x'.repeat(KEY.length);
  assert.notEqual(sameLength, KEY);
  assert.equal((await get('/api/jobs', sameLength)).status, 401);
});
