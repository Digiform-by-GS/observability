import { getLogger } from '@digiform/observability';
import { startService } from './service.js';

const PORT = Number(process.env.PORT ?? 8080);
const ORDERS_URL = process.env.ORDERS_URL ?? 'http://localhost:8082';

startService('checkout-api', PORT, (app) => {
  const log = getLogger();

  app.get('/checkout', async (req, res, next) => {
    const amount = Number(req.query.amount ?? 42);

    try {
      log.info({ amount }, 'starting checkout');

      const response = await fetch(`${ORDERS_URL}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount }),
      });

      if (!response.ok) {
        throw new Error(`orders responded ${response.status}`);
      }

      const order = (await response.json()) as { orderId?: string };
      log.info({ orderId: order.orderId }, 'checkout complete');
      res.json({ status: 'ok', order });
    } catch (err) {
      next(err);
    }
  });
});
