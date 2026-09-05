import { describe, expect, it } from 'vitest';
import { resolveRetention, selectForRemoval } from '../src/retention.js';
import type { StoredArchive } from '../src/types.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 8, 5);

function archive(daysAgo: number, bytes = 100): StoredArchive {
  return {
    key: `app-${daysAgo}.log.gz`,
    location: `/archive/app-${daysAgo}.log.gz`,
    bytes,
    createdAt: now - daysAgo * DAY,
  };
}

const archives = [archive(0), archive(1), archive(2), archive(10), archive(40)];

describe('selectForRemoval', () => {
  it('keeps the newest maxFiles', () => {
    const removed = selectForRemoval(archives, resolveRetention({ maxFiles: 2 })!, now);
    expect(removed.map((a) => a.key)).toEqual(['app-2.log.gz', 'app-10.log.gz', 'app-40.log.gz']);
  });

  it('drops archives past maxAge', () => {
    const removed = selectForRemoval(archives, resolveRetention({ maxAge: '7d' })!, now);
    expect(removed.map((a) => a.key)).toEqual(['app-10.log.gz', 'app-40.log.gz']);
  });

  it('unions the limits rather than letting one exempt an archive', () => {
    const policy = resolveRetention({ maxFiles: 4, maxAge: '7d' })!;
    const removed = selectForRemoval(archives, policy, now);
    expect(removed.map((a) => a.key)).toEqual(['app-10.log.gz', 'app-40.log.gz']);
  });

  it('trims to a total size budget, newest first', () => {
    const removed = selectForRemoval(archives, resolveRetention({ maxTotalSize: 250 })!, now);
    expect(removed.map((a) => a.key)).toEqual(['app-2.log.gz', 'app-10.log.gz', 'app-40.log.gz']);
  });

  it('never deletes the archive that was just written', () => {
    const removed = selectForRemoval([archive(0, 5000)], resolveRetention({ maxTotalSize: 10 })!, now);
    expect(removed).toEqual([]);
  });

  it('keeps everything when retention is disabled', () => {
    expect(resolveRetention(false)).toBeNull();
  });

  it('defaults to ten files', () => {
    expect(resolveRetention(undefined)).toEqual({
      maxFiles: 10,
      maxAgeMs: null,
      maxTotalBytes: null,
    });
  });
});
