import { describe, expect, it } from 'vitest';
import { age, all, any, daily, every, firstMatch, size, when } from '../src/triggers.js';
import type { TriggerContext } from '../src/types.js';

const HOUR = 3_600_000;

function context(overrides: Partial<TriggerContext> & { size?: number } = {}): TriggerContext {
  const now = overrides.now ?? Date.UTC(2026, 8, 5, 12, 0, 0);
  return {
    path: '/tmp/app.log',
    now,
    lastArchivedAt: overrides.lastArchivedAt ?? null,
    stats:
      overrides.stats !== undefined
        ? overrides.stats
        : { size: overrides.size ?? 0, birthtimeMs: now, mtimeMs: now },
  };
}

describe('size', () => {
  it('fires at or above the limit', () => {
    const trigger = size('1kb');
    expect(trigger.test(context({ size: 1023 }))).toBe(false);
    expect(trigger.test(context({ size: 1024 }))).toBe(true);
  });

  it('treats a missing file as empty', () => {
    expect(size(1).test(context({ stats: null }))).toBe(false);
  });
});

describe('age', () => {
  const trigger = age('24h');
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);

  it('measures from the file, not from the last rotation', () => {
    const young = { size: 1, birthtimeMs: now - 23 * HOUR, mtimeMs: now };
    const old = { size: 1, birthtimeMs: now - 25 * HOUR, mtimeMs: now };
    expect(trigger.test(context({ now, stats: young }))).toBe(false);
    expect(trigger.test(context({ now, stats: old }))).toBe(true);
  });

  it('falls back to mtime when the platform reports no birthtime', () => {
    const stats = { size: 1, birthtimeMs: 0, mtimeMs: now - 25 * HOUR };
    expect(trigger.test(context({ now, stats }))).toBe(true);
  });

  it('reports when it will next be due', () => {
    const stats = { size: 1, birthtimeMs: now, mtimeMs: now };
    expect(trigger.dueAt?.(context({ now, stats }))).toBe(now + 24 * HOUR);
  });
});

describe('every', () => {
  const trigger = every('1h');
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);

  it('counts from the last rotation once there has been one', () => {
    expect(trigger.test(context({ now, lastArchivedAt: now - HOUR }))).toBe(true);
    expect(trigger.test(context({ now, lastArchivedAt: now - HOUR / 2 }))).toBe(false);
  });

  it('falls back to the file age so a fresh process still rotates', () => {
    const stale = { size: 1, birthtimeMs: now - 2 * HOUR, mtimeMs: now - 2 * HOUR };
    const fresh = { size: 1, birthtimeMs: now, mtimeMs: now };
    expect(trigger.test(context({ now, lastArchivedAt: null, stats: stale }))).toBe(true);
    expect(trigger.test(context({ now, lastArchivedAt: null, stats: fresh }))).toBe(false);
  });

  it('reports when it is next due from either anchor', () => {
    expect(trigger.dueAt?.(context({ now, lastArchivedAt: now }))).toBe(now + HOUR);
    expect(trigger.dueAt?.(context({ now, stats: null }))).toBeNull();
  });
});

describe('daily', () => {
  it('fires once past the cutoff and not again that day', () => {
    const trigger = daily('00:00');
    const morning = new Date(2026, 8, 5, 9, 0, 0).getTime();
    const yesterday = new Date(2026, 8, 4, 23, 0, 0).getTime();
    expect(trigger.test(context({ now: morning, lastArchivedAt: yesterday }))).toBe(true);
    expect(trigger.test(context({ now: morning, lastArchivedAt: morning - HOUR }))).toBe(false);
  });

  it('uses the file age before anything has been archived', () => {
    const trigger = daily('03:00');
    const now = new Date(2026, 8, 5, 4, 0, 0).getTime();
    const born = new Date(2026, 8, 5, 2, 0, 0).getTime();
    expect(trigger.test(context({ now, stats: { size: 1, birthtimeMs: born, mtimeMs: born } }))).toBe(
      true,
    );
  });

  it('rejects a malformed time', () => {
    expect(() => daily('25:00')).toThrow(RangeError);
    expect(() => daily('noon')).toThrow(RangeError);
  });
});

describe('combinators', () => {
  const big = size(100);
  const old = age('1h');
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);
  const bigAndYoung = context({ now, stats: { size: 200, birthtimeMs: now, mtimeMs: now } });

  it('any fires on the first match', () => {
    expect(any(big, old).test(bigAndYoung)).toBe(true);
  });

  it('all needs every match', () => {
    expect(all(big, old).test(bigAndYoung)).toBe(false);
    expect(all().test(bigAndYoung)).toBe(false);
  });

  it('firstMatch names the trigger that fired', () => {
    expect(firstMatch([old, big], bigAndYoung)?.name).toBe(big.name);
    expect(firstMatch([old], bigAndYoung)).toBeNull();
  });

  it('when() wraps a custom predicate', () => {
    const trigger = when('friday', (c) => new Date(c.now).getUTCDay() === 6);
    expect(trigger.test(bigAndYoung)).toBe(true);
  });
});
