import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { getLogger } from '@digiform-by-gs/observability';

/**
 * Shared Express bootstrap. Every service gets the same request log, /healthy
 * probe, error handler and graceful shutdown, so the per-service files below
 * contain only their actual business route.
 */
export function startService(name: string, port: number, mount: (app: Express) => void): void {
  const log = getLogger();
  const app = express();

  app.use(express.json());

  app.use((req, _res, next) => {
    log.info({ method: req.method, path: req.path }, 'request received');
    next();
  });

  app.get('/healthy', (_req, res) => {
    res.json({ status: 'ok', service: name });
  });

  mount(app);

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // Logged with the active span in scope, so this record carries the trace_id
    // that ties it to the same trace as the caller's failure.
    log.error({ err: { message: err.message, stack: err.stack }, service: name }, 'unhandled error');
    res.status(500).json({ error: err.message, service: name });
  });

  const server = app.listen(port, () => {
    log.info({ port, service: name }, `${name} listening`);
  });

  const stop = (signal: string): void => {
    log.info({ signal, service: name }, 'shutting down http server');
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}
