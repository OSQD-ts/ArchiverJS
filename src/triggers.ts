/**
 * Built-in triggers.
 *
 * A trigger is a pure predicate over a {@link TriggerContext}. Nothing here
 * touches the filesystem or the clock directly, which keeps the decision logic
 * — the part that is easy to get subtly wrong — fully unit-testable.
 */

import type { Trigger, TriggerContext } from './types.js';
import { parseDuration, parseSize, type DurationInput, type SizeInput } from './units.js';

/** Archive once the file reaches `limit` bytes. */
export function size(limit: SizeInput): Trigger {
  const bytes = parseSize(limit, 'size()');
  return {
    name: `size>=${bytes}`,
    test: (context) => (context.stats?.size ?? 0) >= bytes,
  };
}

/**
 * Archive once the file itself is older than `limit`.
 *
 * Age is measured from the file's creation time where the platform reports one,
 * falling back to its last modification. Use this for "roll the log every day
 * even if it stays small".
 */
export function age(limit: DurationInput): Trigger {
  const ms = parseDuration(limit, 'age()');
  return {
    name: `age>=${ms}ms`,
    test: (context) => {
      const born = birthOf(context);
      return born !== null && context.now - born >= ms;
    },
    dueAt: (context) => {
      const born = birthOf(context);
      return born === null ? null : born + ms;
    },
  };
}

/**
 * Archive on a fixed cadence — every hour, every week.
 *
 * The clock starts at the last archival this process performed, falling back to
 * the file's own age before there has been one, so a freshly started process
 * still rotates a log that has been sitting there for a week.
 */
export function every(period: DurationInput): Trigger {
  const ms = parseDuration(period, 'every()');
  const since = (context: TriggerContext): number | null =>
    context.lastArchivedAt ?? birthOf(context);
  return {
    name: `every ${ms}ms`,
    test: (context) => {
      const anchor = since(context);
      return anchor === null ? false : context.now - anchor >= ms;
    },
    dueAt: (context) => {
      const anchor = since(context);
      return anchor === null ? null : anchor + ms;
    },
  };
}

/**
 * Archive at a wall-clock time of day, e.g. `daily('00:00')` for midnight
 * rotation. Fires once per day: the first check at or after the cutoff that has
 * not already archived since it.
 */
export function daily(at = '00:00'): Trigger {
  const match = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) {
    throw new RangeError(`daily(): expected a 'HH:MM' time, got '${at}'`);
  }
  const cutoffBefore = (now: number): number => {
    const boundary = new Date(now);
    boundary.setHours(hour, minute, 0, 0);
    // Before today's cutoff, the most recent one was yesterday's.
    if (boundary.getTime() > now) boundary.setDate(boundary.getDate() - 1);
    return boundary.getTime();
  };
  return {
    name: `daily@${at}`,
    test: (context) => {
      const cutoff = cutoffBefore(context.now);
      const since = context.lastArchivedAt ?? birthOf(context);
      return since === null ? false : since < cutoff;
    },
    dueAt: (context) => {
      const next = new Date(cutoffBefore(context.now));
      next.setDate(next.getDate() + 1);
      return next.getTime();
    },
  };
}

/** Wrap your own predicate. */
export function when(name: string, test: (context: TriggerContext) => boolean): Trigger {
  return { name, test };
}

/** Fires when any of `triggers` fires. This is also what a `when: [...]` array means. */
export function any(...triggers: Trigger[]): Trigger {
  return {
    name: triggers.map((t) => t.name).join(' | '),
    test: (context) => triggers.some((t) => t.test(context)),
    dueAt: (context) => earliest(triggers, context),
  };
}

/** Fires only when every one of `triggers` fires — e.g. "big *and* old". */
export function all(...triggers: Trigger[]): Trigger {
  return {
    name: triggers.map((t) => t.name).join(' & '),
    test: (context) => triggers.length > 0 && triggers.every((t) => t.test(context)),
    dueAt: (context) => earliest(triggers, context),
  };
}

/** The first trigger in `triggers` that fires, or `null`. */
export function firstMatch(triggers: readonly Trigger[], context: TriggerContext): Trigger | null {
  for (const trigger of triggers) {
    if (trigger.test(context)) return trigger;
  }
  return null;
}

/** Soonest moment any trigger claims it could fire; `null` when none can say. */
export function earliest(triggers: readonly Trigger[], context: TriggerContext): number | null {
  let soonest: number | null = null;
  for (const trigger of triggers) {
    const due = trigger.dueAt?.(context) ?? null;
    if (due !== null && (soonest === null || due < soonest)) soonest = due;
  }
  return soonest;
}

function birthOf(context: TriggerContext): number | null {
  const stats = context.stats;
  if (!stats) return null;
  // Some filesystems report birthtime as 0 (or as mtime); prefer whichever is a
  // real, earlier timestamp. Floored because `stat` reports sub-millisecond
  // precision while `Date.now()` does not, and a due time half a millisecond in
  // the future of "now" is a confusing thing to hand anyone.
  const birth = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
  return Math.floor(Math.min(birth, stats.mtimeMs));
}
