import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapArtifacts } from './reaper.js';

async function jobDir(root: string, name: string, ageMs: number): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'onboarding.patch'), 'diff --git a/x b/x\n');
  const when = new Date(Date.now() - ageMs);
  await utimes(dir, when, when);
  return dir;
}

test('removes artifacts past the TTL and keeps fresh ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reaper-'));
  try {
    await jobDir(root, 'old', 48 * 60 * 60 * 1000);
    await jobDir(root, 'fresh', 60 * 1000);

    const removed = await reapArtifacts(root, 24 * 60 * 60 * 1000);

    assert.equal(removed, 1);
    const left = await readdir(root);
    assert.deepEqual(left, ['fresh'], 'the fresh job must survive');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing artifact root is not an error', async () => {
  assert.equal(await reapArtifacts(join(tmpdir(), 'reaper-does-not-exist-xyz'), 1000), 0);
});

test('sweeping twice is harmless', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reaper-'));
  try {
    await jobDir(root, 'old', 48 * 60 * 60 * 1000);
    assert.equal(await reapArtifacts(root, 1000), 1);
    assert.equal(await reapArtifacts(root, 1000), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
