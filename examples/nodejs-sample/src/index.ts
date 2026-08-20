import express, { type NextFunction, type Request, type Response } from 'express';
import { getLogger } from '@digiform-by-gs/observability';
import { buildRouter } from './routes.js';

const log = getLogger();
const PORT = Number(process.env.PORT ?? 8080);

const app = express();

app.use((req, _res, next) => {
  log.info({ method: req.method, path: req.path }, 'request received');
  next();
});

app.use(buildRouter(PORT));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ err: { message: err.message, stack: err.stack } }, 'unhandled error');
  res.status(500).json({ error: err.message });
});

const server = app.listen(PORT, () => {
  log.info({ port: PORT }, 'nodejs-sample listening');
});

// initObservability (called by the preload) already installs SIGTERM/SIGINT
// handlers that flush telemetry. We just need to close the HTTP server on top
// of that so in-flight requests finish first.
const stop = (signal: string) => {
  log.info({ signal }, 'shutting down http server');
  server.close(() => process.exit(0));
};
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
