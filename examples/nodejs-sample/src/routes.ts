import { SpanStatusCode } from '@opentelemetry/api';
import { Router } from 'express';
import { getLogger, getMeter, getTracer } from '@digiform/observability';

const tracer = getTracer('nodejs-sample');
const meter = getMeter('nodejs-sample');

const requestCounter = meter.createCounter('app.requests', {
  description: 'Number of requests by route.',
});
const workCounter = meter.createCounter('app.work.invocations', {
  description: 'Times /work was called.',
});

export function buildRouter(port: number): Router {
  const router = Router();
  const log = getLogger();

  router.get('/healthy', (_req, res) => {
    requestCounter.add(1, { route: '/healthy' });
    res.json({ status: 'ok' });
  });

  router.get('/slow', async (_req, res) => {
    requestCounter.add(1, { route: '/slow' });
    const delay = 200 + Math.floor(Math.random() * 300);
    await new Promise((resolve) => setTimeout(resolve, delay));
    res.json({ status: 'ok', delayMs: delay });
  });

  router.get('/error', (_req, _res) => {
    requestCounter.add(1, { route: '/error' });
    log.warn('about to throw on /error');
    throw new Error('intentional error for demo purposes');
  });

  router.get('/work', async (_req, res, next) => {
    requestCounter.add(1, { route: '/work' });
    workCounter.add(1, { route: '/work' });

    try {
      const status = await tracer.startActiveSpan('downstream-fetch', async (span) => {
        try {
          const response = await fetch(`http://localhost:${port}/healthy`);
          span.setAttribute('http.response.status_code', response.status);
          if (!response.ok) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: `status ${response.status}` });
          }
          return response.status;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      });
      res.json({ ok: true, downstreamStatus: status });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
