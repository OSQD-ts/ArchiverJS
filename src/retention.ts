/**
 * Retention — deciding which archives to drop.
 *
 * Kept as a pure function over a list of archives so the (destructive) policy
 * can be tested exhaustively without ever creating a file.
 */

import type { ArchiveStore, RetentionPolicy, StoredArchive } from './types.js';
import { parseDuration, parseSize } from './units.js';

/** A {@link RetentionPolicy} with its human units resolved. */
export interface ResolvedRetention {
  maxFiles: number | null;
  maxAgeMs: number | null;
  maxTotalBytes: number | null;
}

/** Applied when a source does not configure `retention`. */
export const DEFAULT_RETENTION: RetentionPolicy = { maxFiles: 10 };

/** Normalize a policy; `false` disables retention entirely. */
export function resolveRetention(policy: RetentionPolicy | false | undefined): ResolvedRetention | null {
  if (policy === false) return null;
  const source = policy ?? DEFAULT_RETENTION;
  return {
    maxFiles: source.maxFiles ?? null,
    maxAgeMs: source.maxAge === undefined ? null : parseDuration(source.maxAge, 'retention.maxAge'),
    maxTotalBytes:
      source.maxTotalSize === undefined
        ? null
        : parseSize(source.maxTotalSize, 'retention.maxTotalSize'),
  };
}

/**
 * Which archives violate `policy`, newest-first order preserved.
 *
 * Every limit is applied independently and the results unioned: surviving the
 * file count does not exempt an archive from the age limit.
 */
export function selectForRemoval(
  archives: readonly StoredArchive[],
  policy: ResolvedRetention,
  now: number,
): StoredArchive[] {
  const newestFirst = [...archives].sort((a, b) => b.createdAt - a.createdAt);
  const doomed = new Set<StoredArchive>();

  if (policy.maxFiles !== null) {
    for (const archive of newestFirst.slice(Math.max(policy.maxFiles, 0))) doomed.add(archive);
  }

  if (policy.maxAgeMs !== null) {
    const cutoff = now - policy.maxAgeMs;
    for (const archive of newestFirst) {
      if (archive.createdAt < cutoff) doomed.add(archive);
    }
  }

  if (policy.maxTotalBytes !== null) {
    let running = 0;
    for (const archive of newestFirst) {
      running += archive.bytes;
      // The newest archive is kept even if it alone busts the budget: deleting
      // what was just written would make the whole run pointless.
      if (running > policy.maxTotalBytes && archive !== newestFirst[0]) doomed.add(archive);
    }
  }

  return newestFirst.filter((archive) => doomed.has(archive));
}

/** Apply `policy` against `store`, deleting what it selects. */
export async function applyRetention(
  store: ArchiveStore,
  archives: readonly StoredArchive[],
  policy: ResolvedRetention,
  now: number,
): Promise<StoredArchive[]> {
  const removed: StoredArchive[] = [];
  for (const archive of selectForRemoval(archives, policy, now)) {
    await store.remove(archive);
    removed.push(archive);
  }
  return removed;
}
