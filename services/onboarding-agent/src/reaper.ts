import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Deletes job artifacts once they age out.
 *
 * Artifacts are the client's source code: onboarding.patch is a diff of their
 * repository, and agent.json is a transcript of everything the agent read.
 * Keeping those indefinitely turns this host into a permanent archive of other
 * people's code — a worse retention story than the API call that produced it,
 * and the part that is entirely within our control.
 *
 * Jobs are minutes long and the patch is meant to be downloaded promptly, so a
 * short TTL costs nothing operationally.
 */
export async function reapArtifacts(root: string, maxAgeMs: number): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0; // nothing created yet
  }

  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const dir = join(root, name);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      // mtime, not ctime: the runner writes results at the end of the job, so
      // mtime tracks when the artifacts were actually finished.
      if (info.mtimeMs < cutoff) {
        await rm(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // A directory vanishing mid-sweep is fine — that is the desired end state.
    }
  }
  return removed;
}

export function startReaper(root: string, maxAgeMs: number, intervalMs: number): void {
  const run = (): void => {
    void reapArtifacts(root, maxAgeMs).then((n) => {
      if (n > 0) console.log(`[onboarding-agent] reaped ${n} expired job artifact dir(s)`);
    });
  };
  run(); // sweep at boot, so a restart clears anything left by a crash
  // unref so a pending sweep never keeps the process alive on shutdown.
  setInterval(run, intervalMs).unref();
}
