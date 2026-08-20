import { randomUUID } from 'node:crypto';
import { getLogger } from '@digiform-by-gs/observability';
import { startProfiling } from './profiling.js';
import { startService } from './service.js';

const PORT = Number(process.env.PORT ?? 8082);
const PAYMENTS_URL = process.env.PAYMENTS_URL ?? 'http://localhost:8083';

await startProfiling('orders');

startService('orders', PORT, (app) => {
  const log = getLogger();

  app.post('/orders', async (req, res, next) => {
    const orderId = randomUUID();
    const amount = Number(req.body?.amount ?? 42);

    try {
      log.info({ orderId, amount }, 'creating order');

      // fetch is auto-instrumented, so the W3C traceparent header is propagated
      // to payments and its span is parented under this request's span.
      const response = await fetch(`${PAYMENTS_URL}/charge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId, amount }),
      });

      if (!response.ok) {
        throw new Error(`payments responded ${response.status}`);
      }

      const payment = await response.json();
      log.info({ orderId }, 'order created');
      res.json({ orderId, amount, payment });
    } catch (err) {
      next(err);
    }
  });
});
