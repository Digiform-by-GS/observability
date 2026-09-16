import { randomUUID } from 'node:crypto';

import type { Provider } from './providers.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type DeliveryMode = 'patch' | 'pr';

/** Where the service actually reads its env in the target environment. */
export type DeploymentConfig = 'in_repo' | 'other_repo' | 'secret_manager' | 'unknown';
export type Signal = 'traces' | 'metrics' | 'logs' | 'rum';
export type SignalState = 'wired' | 'not_wired' | 'n/a';

/**
 * How browser telemetry gets from the page to the collector.
 *
 * `proxy` is the default because it is correct wherever a server exists, and
 * the two things that break `direct` are both invisible from the repository:
 * an HTTPS page cannot POST to a plain-HTTP collector (mixed content, blocked
 * before the request leaves), and a collector on a private address is not
 * reachable from a visitor's browser at all. Neither produces an error the
 * application can see.
 *
 * `direct` is an override for an app whose users are all on the same network
 * as the platform — an internal tool behind a VPN.
 */
export type BrowserIngest = 'proxy' | 'direct';
export const BROWSER_INGESTS: readonly BrowserIngest[] = ['proxy', 'direct'];

export const SIGNALS: readonly Signal[] = ['traces', 'metrics', 'logs', 'rum'];
export const DEPLOYMENT_CONFIGS: readonly DeploymentConfig[] = [
  'in_repo',
  'other_repo',
  'secret_manager',
  'unknown',
];

export interface SignalReport {
  /**
   * `wired` means the code path is present in the diff — NOT that telemetry
   * arrives. The agent never runs the application, so it cannot know that;
   * confirming delivery is the verify skill's job. Any UI built on this must
   * not imply otherwise.
   */
  state: SignalState;
  reason?: string | null;
}

export interface JobRequest {
  repoUrl: string;
  provider: Provider;
  mode: DeliveryMode;
  serviceName?: string;
  team?: string;
  baseBranch?: string;
  /**
   * The questionnaire. Each of these is something the agent cannot learn by
   * reading the repository — which is the only test a question has to pass to
   * earn a slot on the form. They improve the precision of what the agent hands
   * back; they are NOT the safety mechanism. The rule that stops it editing a
   * dead Helm chart lives in the skill, because a form field can be skipped and
   * `unknown` is what most people will send.
   */
  deploymentConfig?: DeploymentConfig;
  /** Free text: repo, file and key. Committed to the client's repo — see server.ts. */
  deploymentConfigLocation?: string;
  environment?: string;
  signals?: Signal[];
  appUrl?: string;
  browserIngest?: BrowserIngest;
  /**
   * Never stored on the Job record and never written to disk — it is handed to
   * the container as an environment variable and dropped. Persisting a
   * customer's repository token would turn this box into a credential store,
   * which is a much larger security problem than the one this service solves.
   */
  gitToken?: string;
}

export interface JobResult {
  /** True when the agent correctly found nothing to onboard. */
  noChanges?: boolean;
  files_changed?: string[];
  summary?: string;
  cost_usd?: number | null;
  pull_request?: string | null;
  base_sha?: string;
  /** Which runner image produced this. Written by run-job.sh. */
  runner_revision?: string;
  /**
   * Per-signal coverage, validated and clamped in run-job.sh before it gets
   * here — the agent writes it, so it is never trusted verbatim.
   * `null` means the agent did not report at all, which the UI shows as drift
   * rather than swallowing: an unreported run is the exact failure this
   * contract exists to make visible.
   */
  signals?: Record<Signal, SignalReport> | null;
  signals_requested?: Signal[];
  /**
   * A signal the client asked for is not wired. Deliberately a quality verdict
   * on the diff, NOT a JobStatus: `status` is the lifecycle (queued → running →
   * terminal), and overloading it would make `succeeded` stop meaning "ran to
   * completion" for every consumer. `noChanges` already set this precedent —
   * run-job.sh emits `no_changes` and runner.ts converts it to a result field
   * while the status stays `succeeded`.
   */
  partial?: boolean;
}

export interface Job {
  id: string;
  status: JobStatus;
  repoUrl: string;
  provider: Provider;
  mode: DeliveryMode;
  serviceName?: string;
  team?: string;
  /**
   * Only the non-sensitive half of the questionnaire is kept on the record.
   * `deploymentConfigLocation` and `appUrl` are deliberately absent: they name
   * internal infrastructure, and GET /api/jobs is unauthenticated even when
   * API_KEY is set (see the auth middleware in server.ts). They reach the
   * container as env vars and are dropped, like gitToken.
   */
  environment?: string;
  signals?: Signal[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: JobResult;
  error?: string;
  hasPatch: boolean;
}

/**
 * In-memory registry with an on-disk artifact directory per job.
 *
 * Deliberately not a database: a pilot needs to know whether onboarding
 * converges, not to survive a restart. Jobs are minutes long and re-runnable,
 * so losing the index costs a re-submit. Swap this for SQLite when job history
 * becomes something anyone actually reads.
 */
export class JobStore {
  private jobs = new Map<string, Job>();

  create(req: JobRequest): Job {
    const job: Job = {
      id: randomUUID(),
      status: 'queued',
      repoUrl: req.repoUrl,
      provider: req.provider,
      mode: req.mode,
      ...(req.serviceName ? { serviceName: req.serviceName } : {}),
      ...(req.team ? { team: req.team } : {}),
      ...(req.environment ? { environment: req.environment } : {}),
      ...(req.signals?.length ? { signals: req.signals } : {}),
      createdAt: new Date().toISOString(),
      hasPatch: false,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(limit = 50): Job[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  update(id: string, patch: Partial<Job>): void {
    const job = this.jobs.get(id);
    if (job) this.jobs.set(id, { ...job, ...patch });
  }
}
