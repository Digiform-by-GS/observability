import { spawn } from 'node:child_process';
import { chown, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobRequest, JobResult } from './jobs.js';

export interface RunnerConfig {
  image: string;
  artifactRoot: string;
  otlpEndpoint: string;
  grafanaUrl: string;
  pyroscopeUrl?: string;
  anthropicApiKey: string;
  budgetUsd: string;
  timeoutMs: number;
}

// Named docker volume holding the shared Go module cache; created on first use.
const GOMODCACHE_VOLUME = process.env.GOMODCACHE_VOLUME ?? 'onboarding-gomodcache';

// Must match the `runner` user created in runner/Dockerfile.
const RUNNER_UID = 10001;
const RUNNER_GID = 10001;

export interface RunOutcome {
  ok: boolean;
  result?: JobResult;
  error?: string;
}

export function artifactDir(root: string, jobId: string): string {
  return join(root, jobId);
}

/**
 * Runs one job in a throwaway container.
 *
 * The container flags are the security boundary, not decoration:
 *  --network bridge  the job needs GitHub/npm/Anthropic, but must NOT be on the
 *                    platform's `obs` network. Nothing it clones should be able
 *                    to reach Loki/Tempo/Mimir directly.
 *  --read-only       plus explicit tmpfs; the clone lives in a tmpfs, artifacts
 *                    in the one bind mount.
 *  --cap-drop ALL / no-new-privileges
 *  --pids-limit / --memory / --cpus  a runaway job must not take the platform
 *                    down with it; this box has 2 vCPU shared with the stack.
 */
export async function runJob(
  jobId: string,
  req: JobRequest,
  cfg: RunnerConfig,
): Promise<RunOutcome> {
  const out = artifactDir(cfg.artifactRoot, jobId);
  await mkdir(out, { recursive: true });
  // The API server runs as root but the runner writes as uid 10001 (non-root by
  // design). Without this the very first write inside the container fails with
  // EACCES on a directory the API just created.
  await chown(out, RUNNER_UID, RUNNER_GID).catch(() => {
    console.warn(`[runner] could not chown ${out}; the job may fail to write artifacts`);
  });

  const env: Record<string, string> = {
    REPO_URL: req.repoUrl,
    PROVIDER: req.provider,
    MODE: req.mode,
    OTLP_ENDPOINT: cfg.otlpEndpoint,
    GRAFANA_URL: cfg.grafanaUrl,
    BUDGET_USD: cfg.budgetUsd,
    ANTHROPIC_API_KEY: cfg.anthropicApiKey,
    ...(cfg.pyroscopeUrl ? { PYROSCOPE_URL: cfg.pyroscopeUrl } : {}),
    ...(req.serviceName ? { SERVICE_NAME: req.serviceName } : {}),
    ...(req.team ? { TEAM: req.team } : {}),
    ...(req.baseBranch ? { BASE_BRANCH: req.baseBranch } : {}),
    ...(req.gitToken ? { GIT_TOKEN: req.gitToken } : {}),
  };

  // Secrets must never reach argv — anything there is readable via
  // `docker inspect` and /proc. `-e NAME` with no value tells docker to take
  // the value from ITS OWN environment, so only variable NAMES are arguments.
  //
  // The first attempt was `--env-file /dev/stdin`, which fails outright:
  // docker cannot open /dev/stdin when spawned with a piped stdin, and the
  // job died with "no such device or address" before the agent ever ran.
  const passThrough = Object.keys(env).flatMap((k) => ['-e', k]);

  const args = [
    'run', '--rm',
    ...passThrough,
    '--network', 'bridge',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '512',
    '--memory', '1g',
    '--cpus', '1.0',
    // uid/gid are required: mounting a tmpfs over /work discards the
    // ownership the Dockerfile set, leaving a root-owned filesystem that the
    // non-root runner cannot write to — git fails with 'could not create
    // work tree dir'. exec is needed because git invokes helper binaries.
    '--tmpfs', `/work:rw,exec,size=512m,uid=${RUNNER_UID},gid=${RUNNER_GID}`,
    '-v', `${out}:/out`,
    // Persistent Go module cache, shared across jobs. Without it every Go job
    // re-downloads the client's entire dependency tree into a throwaway
    // container — the first real repo, with the GCP client libraries, blew the
    // 15 minute timeout doing exactly that.
    //
    // Sharing it between clients is safe: the cache holds public modules only,
    // each verified against sum.golang.org, and jobs run one at a time so
    // there is no concurrent-write race. It holds nothing client-specific —
    // the clone itself lives in the tmpfs and dies with the container.
    '-v', `${GOMODCACHE_VOLUME}:/home/runner/go/pkg/mod`,
    cfg.image,
  ];

  return await new Promise<RunOutcome>((resolve) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // The values live here, in the docker CLI's own environment; the
      // `-e NAME` flags above are what pull them into the container.
      env: { ...process.env, ...env },
    });
    let stderr = '';
    let settled = false;

    const finish = (o: RunOutcome) => {
      if (!settled) {
        settled = true;
        resolve(o);
      }
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `job exceeded ${Math.round(cfg.timeoutMs / 1000)}s and was killed` });
    }, cfg.timeoutMs);

    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: `could not start docker: ${err.message}` });
    });

    child.on('close', async () => {
      clearTimeout(timer);
      // result.json is written by the runner for both success and failure, so
      // it is the authority; the exit code only matters when it is missing.
      try {
        const raw = await readFile(join(out, 'result.json'), 'utf8');
        const parsed = JSON.parse(raw) as JobResult & { status?: string; error?: string };
        // 'no_changes' is a legitimate answer — a repo with nothing to onboard.
        // Reporting it as failure is what taught the agent to invent files.
        if (parsed.status === 'succeeded' || parsed.status === 'no_changes') {
          finish({ ok: true, result: { ...parsed, noChanges: parsed.status === 'no_changes' } });
        } else {
          finish({ ok: false, error: parsed.error ?? 'job failed without a reason' });
        }
      } catch {
        finish({
          ok: false,
          error: `the runner produced no result. ${stderr.trim().slice(-500) || 'no stderr'}`,
        });
      }
    });

  });
}
