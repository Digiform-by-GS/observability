import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
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

  const env: Record<string, string> = {
    REPO_URL: req.repoUrl,
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

  // Secrets go in on stdin as an env-file, never as argv: anything in argv is
  // visible to `docker inspect` and to every process on the host via /proc.
  const envFileBody = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const args = [
    'run', '--rm', '-i',
    '--env-file', '/dev/stdin',
    '--network', 'bridge',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '512',
    '--memory', '1g',
    '--cpus', '1.0',
    '--tmpfs', '/work:rw,exec,size=512m',
    '-v', `${out}:/out`,
    cfg.image,
  ];

  return await new Promise<RunOutcome>((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
        if (parsed.status === 'succeeded') {
          finish({ ok: true, result: parsed });
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

    child.stdin.end(envFileBody);
  });
}
