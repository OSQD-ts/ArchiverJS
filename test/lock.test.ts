/**
 * The lock decides whether a second archiver may touch a file someone else is
 * mid-way through rotating, so its "is this owner really gone?" logic is worth
 * pinning down case by case.
 */

import { readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquire } from '../src/internal/lock.js';
import { spawnIdleProcess, tempDir } from './helpers.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const DEAD_PID = 0x7ffffff0;

async function writeLock(
  path: string,
  record: { pid?: number; host?: string; since?: number } | string,
): Promise<void> {
  await writeFile(
    `${path}.archiving.lock`,
    typeof record === 'string' ? record : JSON.stringify(record),
  );
}

describe('acquire', () => {
  it('takes a free lock and releases it', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');

    const release = await acquire(path);
    expect(release).not.toBeNull();
    expect(await readdir(dir)).toEqual(['app.log.archiving.lock']);

    const held = JSON.parse(await readFile(`${path}.archiving.lock`, 'utf8')) as {
      pid: number;
      host: string;
    };
    expect(held.pid).toBe(process.pid);
    expect(held.host).toBe(hostname());

    await release!();
    expect(await readdir(dir)).toEqual([]);
  });

  it('is safe to release twice', async () => {
    const dir = await tempDir();
    const release = await acquire(join(dir, 'app.log'));
    await release!();
    await expect(release!()).resolves.toBeUndefined();
  });

  it('refuses while a live owner holds it', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeLock(path, { pid: await spawnIdleProcess(), host: hostname(), since: Date.now() });

    expect(await acquire(path)).toBeNull();
  });

  it('takes over from an owner that no longer exists', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeLock(path, { pid: DEAD_PID, host: hostname(), since: Date.now() });

    const release = await acquire(path);
    expect(release).not.toBeNull();
    await release!();
  });

  it('takes over from a live pid once the lock is impossibly old', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    // The owner is alive, but no rotation runs for two days — a recycled pid.
    await writeLock(path, {
      pid: await spawnIdleProcess(),
      host: hostname(),
      since: Date.now() - 2 * DAY,
    });

    expect(await acquire(path)).not.toBeNull();
  });

  it('honours a fresh lock from another host, whose pid means nothing here', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeLock(path, { pid: DEAD_PID, host: 'some-other-host', since: Date.now() });

    expect(await acquire(path)).toBeNull();
  });

  it('takes over a stale lock from another host', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeLock(path, { pid: DEAD_PID, host: 'some-other-host', since: Date.now() - 2 * HOUR });

    expect(await acquire(path)).not.toBeNull();
  });

  it('judges a corrupt lock by its age alone', async () => {
    const dir = await tempDir();
    const fresh = join(dir, 'fresh.log');
    const old = join(dir, 'old.log');
    await writeLock(fresh, 'not json at all');
    await writeLock(old, 'not json at all');
    const past = new Date(Date.now() - 2 * HOUR);
    await utimes(`${old}.archiving.lock`, past, past);

    expect(await acquire(fresh)).toBeNull();
    expect(await acquire(old)).not.toBeNull();
  });

  it('only ever lets one caller in', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');

    const results = await Promise.all(Array.from({ length: 8 }, () => acquire(path)));
    const winners = results.filter((release) => release !== null);

    expect(winners).toHaveLength(1);
    await winners[0]!();
    expect(await acquire(path)).not.toBeNull();
  });

  it('leaves the lock file readable for a human debugging a wedge', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const release = await acquire(path);
    expect((await stat(`${path}.archiving.lock`)).mode & 0o444).toBeTruthy();
    await release!();
  });
});
