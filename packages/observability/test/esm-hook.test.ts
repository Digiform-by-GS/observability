import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Regression guard for the silent defect that made every Express endpoint
// collapse into a single metric series.
//
// OTel patches Node core modules through the require hook, so `http` spans
// appear and a service looks correctly instrumented. Userland packages loaded
// from an ESM entry point are NOT patched unless the ESM loader hook is
// registered — so express never got wrapped, server spans were named after the
// bare method (`GET`, `POST`), and `http.route` was never set. Per-route RED
// metrics silently did not exist, and nothing errored.
//
// This has to be an integration test in a real child process: the failure is a
// property of module loading under `node --import`, which cannot be reproduced
// in-process by vitest. It exercises dist/, so CI must build before testing
// (it does — see the Build wrapper step).

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRELOAD = join(PKG_ROOT, 'dist', 'preload.js');

interface ExportedSpan {
  name: string;
  attributes: { key: string; value: Record<string, unknown> }[];
}

let server: Server;
let tmp: string;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('ESM loader hook', () => {
  it('instruments express so server spans carry the route template', async () => {
    const spans: ExportedSpan[] = [];

    // Minimal OTLP/HTTP sink: collect trace payloads, 200 everything else.
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url?.endsWith('/v1/traces')) {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            for (const rs of body.resourceSpans ?? [])
              for (const ss of rs.scopeSpans ?? []) spans.push(...(ss.spans ?? []));
          } catch {
            // A malformed batch just means no spans recorded; the assertion below reports it.
          }
        }
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The app must be ESM and must import express AFTER the preload runs —
    // i.e. the ordinary shape of a real service.
    //
    // It lives inside the package, not the OS temp dir: ESM resolution walks up
    // from the importing file looking for node_modules, and NODE_PATH does not
    // apply to it (that is a CJS-only mechanism). From a temp dir, `import
    // express` fails outright and the child dies before emitting anything.
    tmp = mkdtempSync(join(PKG_ROOT, '.esm-hook-test-'));
    const app = join(tmp, 'app.mjs');
    writeFileSync(
      app,
      `
import express from 'express';
const app = express();
app.get('/orders/:id', (_req, res) => res.json({ ok: true }));
const server = app.listen(0, async () => {
  const port = server.address().port;
  // Two distinct URLs on one route: they must collapse to a single span name.
  await fetch(\`http://127.0.0.1:\${port}/orders/1\`);
  await fetch(\`http://127.0.0.1:\${port}/orders/2\`);
  server.close();
});
`,
    );

    // --import needs a file:// URL: on Windows a bare `C:\...` path is rejected
    // as an unsupported URL scheme. Real services pass the bare package
    // specifier, which sidesteps this entirely.
    const child = spawn(process.execPath, ['--import', pathToFileURL(PRELOAD).href, app], {
      env: {
        ...process.env,
        OTEL_SERVICE_NAME: 'esm-hook-test',
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      },
      cwd: PKG_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let childErr = '';
    child.stderr?.on('data', (d: Buffer) => (childErr += d.toString()));

    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      // Natural exit flushes via beforeExit; this bound stops a hang from
      // becoming an indefinite one.
      setTimeout(() => {
        child.kill();
        resolve();
      }, 25_000);
    });

    const names = spans.map((s) => s.name);
    const server_spans = names.filter((n) => n.includes('/orders'));

    expect(
      server_spans.length,
      `no span named after the route. Got: ${JSON.stringify(names)}. ` +
        'This means the ESM loader hook is not registered and express went unpatched.' +
        (childErr ? `\nchild stderr:\n${childErr}` : ''),
    ).toBeGreaterThan(0);

    // The whole point: the concrete ids must not reach the span name.
    expect(server_spans.some((n) => n.includes('/orders/:id'))).toBe(true);
    expect(server_spans.some((n) => /\/orders\/[0-9]/.test(n))).toBe(false);
  }, 40_000);
});
