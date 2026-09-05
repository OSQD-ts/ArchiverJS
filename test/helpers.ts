import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const created: string[] = [];
const spawned: Array<() => void> = [];

/**
 * Windows has no POSIX file modes, no unprivileged symlinks and no `chown`.
 * Tests that assert on any of those describe the platform, not the library.
 */
export const POSIX = process.platform !== 'win32';

/** A fresh temporary directory, removed after the test. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archiverjs-'));
  created.push(dir);
  return dir;
}

/**
 * A real, live process that is not this one.
 *
 * Lock and orphan handling both ask "is the owner still running?", and the only
 * honest way to test that is with a process that genuinely is. Hard-coding pid
 * 1 works on Linux and lies everywhere else.
 */
export async function spawnIdleProcess(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    stdio: 'ignore',
  });
  spawned.push(() => child.kill('SIGKILL'));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return child.pid!;
}

afterEach(async () => {
  for (const kill of spawned.splice(0)) kill();
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
