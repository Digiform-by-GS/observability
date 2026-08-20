import { getLogger } from '@digiform-by-gs/observability';
import { startProfiling } from './profiling.js';
import { startService } from './service.js';

const PORT = Number(process.env.PORT ?? 8083);

// Flipped at runtime via POST /admin/failure-mode — this is the fault injection
// point for the blast-radius demo. payments is the leaf of the call chain, so
// everything upstream of it should light up when this is on.
let failureMode = false;

await startProfiling('payments');

startService('payments', PORT, (app) => {
  const log = getLogger();

  app.post('/charge', (req, res) => {
    const { orderId, amount } = req.body ?? {};

    if (failureMode) {
      log.error({ orderId, amount }, 'payment gateway unavailable');
      throw new Error('payment gateway unavailable');
    }

    log.info({ orderId, amount }, 'payment charged');
    res.json({ status: 'charged', orderId, amount });
  });

  app.post('/admin/failure-mode', (req, res) => {
    failureMode = Boolean(req.body?.enabled);
    log.warn({ failureMode }, 'payments failure mode toggled');
    res.json({ failureMode });
  });

  app.get('/admin/failure-mode', (_req, res) => {
    res.json({ failureMode });
  });
});
