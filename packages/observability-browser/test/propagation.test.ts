/**
 * Trace-context propagation, tested against a real HTTP server.
 *
 * This is the behaviour that makes browser RUM worth having — a click and the
 * server handler that served it in one trace — and also the one that can break
 * the application it instruments. Adding `traceparent` to a cross-origin
 * request makes that request preflighted, so a backend which does not allow the
 * header rejects the preflight and the real request never happens.
 *
 * Assertions are on headers the SERVER actually received, not on the
 * instrumentation's configuration. Config-shaped assertions would pass just as
 * happily if the option had been renamed upstream.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { context, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';

interface Received {
  url: string;
  method: string;
  traceparent?: string;
}

let server: Server;
let origin: string;
let received: Received[] = [];

let exporter: InMemorySpanExporter;
let provider: WebTracerProvider;
let unregister: () => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push({
      url: req.url ?? '',
      method: req.method ?? '',
      traceparent: req.headers['traceparent'] as string | undefined,
    });
    // Permissive CORS, including traceparent. A backend configured like this is
    // the precondition for enabling propagation at all.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'traceparent,tracestate,content-type');
    res.setHeader('Timing-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function setup(propagateTo: (string | RegExp)[]): void {
  exporter = new InMemorySpanExporter();
  provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register({ propagator: new W3CTraceContextPropagator() });
  unregister = registerInstrumentations({
    instrumentations: [
      new FetchInstrumentation({
        propagateTraceHeaderCorsUrls: propagateTo,
        ignoreUrls: [/\/ignored/],
      }),
    ],
  });
}

beforeEach(() => {
  received = [];
});

afterEach(async () => {
  unregister?.();
  await provider?.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe('fetch trace propagation', () => {
  it('sends traceparent to an allowlisted cross-origin URL', async () => {
    setup([new RegExp(origin)]);

    await fetch(`${origin}/orders`);

    const call = received.find((r) => r.url === '/orders' && r.method === 'GET');
    expect(call).toBeDefined();
    expect(call?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  // The other half, and the half that matters for safety: a URL outside the
  // allowlist must stay un-preflighted. If propagation leaked to every origin,
  // enabling this package would start breaking third-party API calls.
  it('does not send traceparent to a URL outside the allowlist', async () => {
    setup([/example\.invalid/]);

    await fetch(`${origin}/orders`);

    const call = received.find((r) => r.url === '/orders' && r.method === 'GET');
    expect(call).toBeDefined();
    expect(call?.traceparent).toBeUndefined();
  });

  it('propagates nothing at all when the allowlist is empty, which is the default', async () => {
    setup([]);

    await fetch(`${origin}/orders`);

    expect(received.find((r) => r.url === '/orders')?.traceparent).toBeUndefined();
  });

  // Span EMISSION is deliberately not asserted here. FetchInstrumentation ends
  // its spans from resource-timing entries, which jsdom does not implement, so
  // no span is ever finished in this environment. A test asserting "the ignored
  // URL produced no span" would therefore pass without proving anything - it
  // passes because nothing produces spans at all. The ignore pattern itself is
  // covered properly in ignore.test.ts, and end-to-end span emission belongs in
  // the browser fixture against a real browser.
});
