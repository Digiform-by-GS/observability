import express from 'express';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobStore, type JobRequest, type DeliveryMode } from './jobs.js';
import { parseRepoUrl, requestNoun } from './providers.js';
import { startReaper } from './reaper.js';
import { runJob, artifactDir, type RunnerConfig } from './runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[onboarding-agent] ${name} is required. Refusing to start.`);
    process.exit(1);
  }
  return v;
}

const cfg: RunnerConfig = {
  image: process.env.RUNNER_IMAGE ?? 'digiform/onboarding-runner:dev',
  artifactRoot: process.env.ARTIFACT_ROOT ?? '/var/lib/onboarding-agent/jobs',
  otlpEndpoint: required('OTLP_ENDPOINT'),
  grafanaUrl: required('GRAFANA_URL'),
  ...(process.env.PYROSCOPE_URL ? { pyroscopeUrl: process.env.PYROSCOPE_URL } : {}),
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  budgetUsd: process.env.BUDGET_USD ?? '2.00',
  timeoutMs: Number(process.env.JOB_TIMEOUT_MS ?? 15 * 60 * 1000),
};

// Optional shared secret. A submitted job can carry a customer's repository
// token, so on anything wider than a trusted LAN this should be set.
const API_KEY = process.env.API_KEY ?? '';

// Self-hosted GitLab is the norm for a lot of the target market, so the host
// allow-list is configuration rather than something baked in.
const GITLAB_HOSTS = (process.env.GITLAB_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

// Derived, not configured: the platform's own addresses are already known from
// the endpoints this service hands to clients, so there is nothing to keep in
// sync and no way to forget.
const SELF_HOSTS = [cfg.otlpEndpoint, cfg.grafanaUrl, cfg.pyroscopeUrl]
  .filter((u): u is string => Boolean(u))
  .flatMap((u) => {
    try {
      return [new URL(u).hostname.toLowerCase()];
    } catch {
      return [];
    }
  });

const store = new JobStore();
const app = express();
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  if (!API_KEY || req.path === '/healthz' || req.method === 'GET') return next();
  if (req.get('x-api-key') === API_KEY) return next();
  res.status(401).json({ error: 'unauthorized' });
});

// --- queue -------------------------------------------------------------------
// Serial by design. The host has 2 vCPU shared with the observability platform;
// running onboarding jobs in parallel would make the platform's own latency a
// function of how many prospects are trying the demo.
const queue: { id: string; req: JobRequest }[] = [];
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const next = queue.shift();
      if (!next) break;
      store.update(next.id, { status: 'running', startedAt: new Date().toISOString() });
      const outcome = await runJob(next.id, next.req, cfg);
      const hasPatch = await access(join(artifactDir(cfg.artifactRoot, next.id), 'onboarding.patch'))
        .then(() => true)
        .catch(() => false);
      store.update(next.id, {
        status: outcome.ok ? 'succeeded' : 'failed',
        finishedAt: new Date().toISOString(),
        hasPatch,
        ...(outcome.result ? { result: outcome.result } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    }
  } finally {
    draining = false;
  }
}

// --- api ---------------------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/api/jobs', (req, res) => {
  const body = req.body as Partial<JobRequest> & { provider?: string };

  const parsed = parseRepoUrl(String(body.repoUrl ?? ''), {
    gitlabHosts: GITLAB_HOSTS,
    blockedHosts: SELF_HOSTS,
    ...(body.provider ? { provider: String(body.provider) } : {}),
  });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const { provider, url: repoUrl } = parsed.repo;

  const mode: DeliveryMode = body.mode === 'pr' ? 'pr' : 'patch';
  if (mode === 'pr' && !body.gitToken) {
    return res.status(400).json({
      error: `mode "pr" requires gitToken with write access (it opens a ${requestNoun(provider)})`,
    });
  }

  const jobReq: JobRequest = {
    repoUrl,
    provider,
    mode,
    ...(body.serviceName ? { serviceName: String(body.serviceName).slice(0, 64) } : {}),
    ...(body.team ? { team: String(body.team).slice(0, 64) } : {}),
    ...(body.baseBranch ? { baseBranch: String(body.baseBranch).slice(0, 128) } : {}),
    ...(body.gitToken ? { gitToken: String(body.gitToken) } : {}),
  };

  const job = store.create(jobReq);
  queue.push({ id: job.id, req: jobReq });
  void drain();
  res.status(202).json({ id: job.id, status: job.status, queued: queue.length });
});

app.get('/api/jobs', (_req, res) => res.json(store.list()));

app.get('/api/jobs/:id', (req, res) => {
  const job = store.get(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'no such job' });
  res.json(job);
});

app.get('/api/jobs/:id/patch', async (req, res) => {
  const id = String(req.params.id);
  const job = store.get(id);
  if (!job) return res.status(404).json({ error: 'no such job' });
  const file = join(artifactDir(cfg.artifactRoot, id), 'onboarding.patch');
  try {
    await access(file);
  } catch {
    return res.status(404).json({ error: 'no patch for this job' });
  }
  res.type('text/plain').setHeader('content-disposition', `attachment; filename="onboarding-${id}.patch"`);
  createReadStream(file).pipe(res);
});

app.use(express.static(join(__dirname, 'public')));

// Artifacts are client source code; hold them only as long as a download
// plausibly needs. Default 24h, overridable for a client who wants less.
const ARTIFACT_TTL_MS = Number(process.env.ARTIFACT_TTL_MS ?? 24 * 60 * 60 * 1000);
startReaper(cfg.artifactRoot, ARTIFACT_TTL_MS, 60 * 60 * 1000);

const port = Number(process.env.PORT ?? 8100);
app.listen(port, () => {
  console.log(`[onboarding-agent] listening on :${port}`);
  console.log(`[onboarding-agent] runner=${cfg.image} budget=$${cfg.budgetUsd} auth=${API_KEY ? 'on' : 'OFF'}`);
  console.log(`[onboarding-agent] artifact TTL=${Math.round(ARTIFACT_TTL_MS / 3600000)}h`);
});
