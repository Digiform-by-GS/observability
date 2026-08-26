import { randomUUID } from 'node:crypto';

import type { Provider } from './providers.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type DeliveryMode = 'patch' | 'pr';

export interface JobRequest {
  repoUrl: string;
  provider: Provider;
  mode: DeliveryMode;
  serviceName?: string;
  team?: string;
  baseBranch?: string;
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
  /** Files matching the shapes onboarding is expected to touch. */
  files_expected?: string[];
  /** Everything else the diff touched — surfaced for a human to read, not blocked. */
  files_for_review?: string[];
  /**
   * Variables the client must set themselves. Deliberately absent from the
   * patch: they belong in .env or deployment config, which are gitignored, so
   * writing them would have dropped them silently.
   */
  required_env?: string[];
  service_name?: string;
  summary?: string;
  cost_usd?: number | null;
  pull_request?: string | null;
  base_sha?: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  repoUrl: string;
  provider: Provider;
  mode: DeliveryMode;
  serviceName?: string;
  team?: string;
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
