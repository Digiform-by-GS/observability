import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// NO exporter mocks here, deliberately — unlike init.test.ts. These tests are
// the regression guard for OTLP auth-header behavior, which lives inside the
// real exporters:
//   1. OTEL_EXPORTER_OTLP_HEADERS from the environment reaches the wire even
//      though init.ts constructs exporters programmatically. This worked by
//      accident before it was tested; a future exporter-construction change
//      (e.g. passing `headers: {}`) would silently break every client that
//      authenticates via env var — which is the SaaS onboarding path.
//   2. The programmatic `headers` option reaches the wire and beats the env
//      var on key collisions (OTel config precedence).
import { initObservability, __resetForTests } from '../src/init.js';
import { getTracer } from '../src/accessors.js';

interface CapturedRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

let server: Server;
let endpoint: string;
let requests: CapturedRequest[];

function startCaptureServer(): Promise<void> {
  requests = [];
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    req.resume();
    req.on('end', () => {
      // 200 with an empty body is a valid (empty) protobuf ExportServiceResponse.
      res.writeHead(200).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

async function exportOneSpan(headers?: Record<string, string>): Promise<void> {
  const handle = initObservability({
    serviceName: 'headers-test',
    endpoint,
    // Keep the test light: the auto-instrumentation set is irrelevant to
    // header transport.
    disableAutoInstrumentations: true,
    ...(headers ? { headers } : {}),
  });
  const span = getTracer('headers-test').startSpan('probe');
  span.end();
  // Shutdown flushes the batch span processor -> a real POST to /v1/traces.
  await handle.shutdown();
}

function traceRequest(): CapturedRequest {
  const req = requests.find((r) => r.url.endsWith('/v1/traces'));
  expect(req, 'expected a POST to /v1/traces to have been captured').toBeDefined();
  return req as CapturedRequest;
}

describe('OTLP export headers', () => {
  beforeEach(async () => {
    __resetForTests();
    await startCaptureServer();
  });

  afterEach(async () => {
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    __resetForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('passes OTEL_EXPORTER_OTLP_HEADERS from the environment to the wire', async () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer env-token,x-tenant=acme';
    await exportOneSpan();

    const req = traceRequest();
    expect(req.headers['authorization']).toBe('Bearer env-token');
    expect(req.headers['x-tenant']).toBe('acme');
  });

  it('passes the programmatic headers option to the wire', async () => {
    await exportOneSpan({ authorization: 'Bearer code-token' });

    const req = traceRequest();
    expect(req.headers['authorization']).toBe('Bearer code-token');
  });

  it('programmatic headers win over the env var on key collisions', async () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer env-token,x-only-env=kept';
    await exportOneSpan({ authorization: 'Bearer code-token' });

    const req = traceRequest();
    expect(req.headers['authorization']).toBe('Bearer code-token');
    // Non-colliding env headers still arrive alongside programmatic ones.
    expect(req.headers['x-only-env']).toBe('kept');
  });
});
