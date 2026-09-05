/**
 * A cross-process lock for one source file.
 *
 * Two archivers pointed at the same log — a stray cron job, a second replica
 * mounting the same volume, a service restarted before the old one was gone —
 * will otherwise rotate on top of each other and interleave the results. The
 * lock is a file created with `wx`, which is atomic on every POSIX filesystem
 * and on Windows, so acquiring it is a single syscall that cannot be raced.
 */

import { open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isNotFound } from './fs.js';

/** What a held lock records about its owner. */
interface LockRecord {
  pid: number;
  host: string;
  since: number;
}

/**
 * How long a lock from another machine is honoured.
 *
 * A pid means nothing across hosts, so a lock written by one can only be judged
 * by age. An hour is far longer than any rotation and short enough that a
 * crashed peer does not wedge a log forever.
 */
const FOREIGN_LOCK_TTL = 3_600_000;

/**
 * The point at which a lock is stale even though its owner is still running.
 *
 * Pid liveness is the right primary signal, but pids are recycled: after a
 * hard kill, a new process can inherit the number of the one that died holding
 * the lock, and nothing would ever clear it. A day is far beyond any honest
 * rotation and short enough that a log cannot be wedged forever.
 */
const ABSOLUTE_LOCK_TTL = 86_400_000;

/** Releases a held lock. Safe to call more than once. */
export type Release = () => Promise<void>;

/**
 * Take the lock for `path`, or return `null` if someone else holds it.
 *
 * A lock left behind by a process that no longer exists is cleared and taken —
 * a crash must not wedge a log permanently.
 */
export async function acquire(path: string, now = Date.now()): Promise<Release | null> {
  const lockPath = `${path}.archiving.lock`;
  const record: LockRecord = { pid: process.pid, host: hostname(), since: now };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o644);
      try {
        await handle.writeFile(JSON.stringify(record));
      } finally {
        await handle.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Someone holds it — or used to. One retry, after clearing a dead owner.
      if (attempt === 1 || !(await clearIfStale(lockPath, record.host, now))) return null;
    }
  }
  return null;
}

/** Remove a lock whose owner is demonstrably gone. Returns `true` if it did. */
async function clearIfStale(lockPath: string, host: string, now: number): Promise<boolean> {
  let held: LockRecord;
  try {
    held = JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord;
  } catch (error) {
    if (isNotFound(error)) return true; // Released while we looked; try again.
    // Unreadable or corrupt: judge it by age alone, like a foreign lock.
    return removeIfOlderThan(lockPath, now - FOREIGN_LOCK_TTL);
  }

  if (typeof held.pid !== 'number' || held.host !== host) {
    return removeIfOlderThan(lockPath, now - FOREIGN_LOCK_TTL, held.since);
  }
  if (isAlive(held.pid) && (held.since ?? now) > now - ABSOLUTE_LOCK_TTL) return false;
  await rm(lockPath, { force: true });
  return true;
}

async function removeIfOlderThan(
  lockPath: string,
  cutoff: number,
  since?: number,
): Promise<boolean> {
  const age = since ?? (await ageOf(lockPath));
  if (age === null || age > cutoff) return false;
  await rm(lockPath, { force: true });
  return true;
}

async function ageOf(lockPath: string): Promise<number | null> {
  try {
    const handle = await open(lockPath, 'r');
    try {
      return (await handle.stat()).mtimeMs;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** `true` if `pid` still exists — EPERM means it exists but belongs to someone else. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
