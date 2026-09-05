/**
 * "When does this next roll, and why has it not yet?" — the questions someone
 * asks at 3am when a disk is filling up.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createArchiver } from '../src/archiver.js';
import { Source } from '../src/source.js';
import { age, any, daily, every, size } from '../src/triggers.js';
import { tempDir } from './helpers.js';

const HOUR = 3_600_000;

describe('nextDueAt', () => {
  it('answers for a time-based trigger', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n');

    const source = new Source({ path, when: age('1h'), destination: join(dir, 'archive') });
    const now = Date.now();
    const due = await source.nextDueAt(now);

    // An hour from the file's birth, which is roughly now.
    expect(due).toBeGreaterThan(now + HOUR - 5_000);
    expect(due).toBeLessThanOrEqual(now + HOUR);
  });

  it('says nothing for a size trigger, which cannot know', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n');

    expect(await new Source({ path, when: size('10mb') }).nextDueAt()).toBeNull();
  });

  it('reports the soonest of several triggers', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n');
    const now = Date.now();

    const source = new Source({ path, when: [size('10mb'), age('4h'), age('1h')] });
    const due = await source.nextDueAt(now);

    expect(due).toBeLessThanOrEqual(now + HOUR);
  });

  it('is null for a file that does not exist', async () => {
    const dir = await tempDir();
    expect(await new Source({ path: join(dir, 'missing.log'), when: age('1h') }).nextDueAt()).toBeNull();
  });

  it('moves forward after a rotation for cadence triggers', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n');
    const source = new Source({
      path,
      when: every('1h'),
      compress: 'none',
      destination: join(dir, 'archive'),
    });

    // Explicit timestamps: `birthtimeMs` is fractional while `Date.now()` is
    // whole milliseconds, so letting both sides pick their own clock makes this
    // comparison flake by a fraction of a millisecond.
    const start = Date.now();
    const before = await source.nextDueAt(start);
    await source.archive('manual', start + 10 * 60_000);
    const after = await source.nextDueAt(start + 10 * 60_000);

    // The cadence now runs from the rotation, not from the file's birth.
    expect(after).toBe(start + 10 * 60_000 + HOUR);
    expect(after!).toBeGreaterThan(before!);
  });

  it('is reported per source by the archiver', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'a.log'), 'body\n');
    await writeFile(join(dir, 'b.log'), 'body\n');

    const archiver = createArchiver({
      sources: [
        { path: join(dir, 'a.log'), when: age('1h') },
        { path: join(dir, 'b.log'), when: size('1gb') },
      ],
    });

    const schedule = await archiver.schedule();
    expect(schedule.map((entry) => entry.source)).toEqual(['a.log', 'b.log']);
    expect(schedule[0]!.dueAt).toBeTypeOf('number');
    expect(schedule[1]!.dueAt).toBeNull();
  });
});

describe('daily and combinator due times', () => {
  it('daily is due at tomorrow’s cutoff', () => {
    const trigger = daily('03:00');
    const now = new Date(2026, 8, 5, 9, 0, 0).getTime();
    const due = trigger.dueAt!({ path: '/x', stats: null, now, lastArchivedAt: null });

    expect(new Date(due!).getDate()).toBe(6);
    expect(new Date(due!).getHours()).toBe(3);
  });

  it('any reports the soonest of its members', () => {
    const now = Date.UTC(2026, 8, 5, 12);
    const stats = { size: 1, birthtimeMs: now, mtimeMs: now };
    const context = { path: '/x', stats, now, lastArchivedAt: null };

    expect(any(age('4h'), age('1h')).dueAt!(context)).toBe(now + HOUR);
    expect(any(size(1)).dueAt!(context)).toBeNull();
  });
});
