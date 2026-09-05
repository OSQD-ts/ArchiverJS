/**
 * Human units for sizes and durations.
 *
 * Every public option that takes a byte count or a millisecond count also
 * accepts a string, because `'10mb'` in a config file survives review far
 * better than `10485760` does.
 */

import { ArchiverConfigError } from './errors.js';

/** A byte count: a number of bytes, or a string such as `'10mb'` / `'1.5 GiB'`. */
export type SizeInput = number | string;

/** A duration: a number of milliseconds, or a string such as `'7d'` / `'1h30m'`. */
export type DurationInput = number | string;

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  msec: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

const TERM = /(\d+(?:\.\d+)?)([a-z]+)/g;

function parseCompound(
  input: string,
  units: Record<string, number>,
  kind: string,
  option: string,
): number {
  // Whitespace is decoration: '1 h 30 m' and '1h30m' mean the same thing.
  const normalized = input.trim().toLowerCase().replace(/\s+/g, '');
  if (normalized === '') throw new ArchiverConfigError(`${option}: empty ${kind} string`);

  // A bare number is taken in the base unit (bytes / milliseconds).
  if (/^\d+(\.\d+)?$/.test(normalized)) return Number(normalized);

  let total = 0;
  let matched = 0;
  for (const [whole, value, unit] of normalized.matchAll(TERM)) {
    const factor = units[unit!];
    if (factor === undefined) {
      throw new ArchiverConfigError(`${option}: unknown ${kind} unit '${unit}' in '${input}'`);
    }
    total += Number(value) * factor;
    matched += whole.length;
  }

  // Reject partial matches like '10mb junk' instead of silently ignoring them.
  if (matched === 0 || matched !== normalized.length) {
    throw new ArchiverConfigError(`${option}: cannot parse ${kind} '${input}'`);
  }
  return total;
}

/** Resolve a {@link SizeInput} to a whole number of bytes. */
export function parseSize(input: SizeInput, option = 'size'): number {
  const bytes =
    typeof input === 'number' ? input : parseCompound(input, SIZE_UNITS, 'size', option);
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new ArchiverConfigError(`${option}: expected a non-negative size, got ${String(input)}`);
  }
  return Math.floor(bytes);
}

/** Resolve a {@link DurationInput} to a whole number of milliseconds. */
export function parseDuration(input: DurationInput, option = 'duration'): number {
  const ms =
    typeof input === 'number' ? input : parseCompound(input, DURATION_UNITS, 'duration', option);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new ArchiverConfigError(
      `${option}: expected a non-negative duration, got ${String(input)}`,
    );
  }
  return Math.floor(ms);
}

const SIZE_SUFFIXES = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** Format a byte count for logs and event payloads. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_SUFFIXES.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(value < 10 ? 2 : 1);
  return `${rounded} ${SIZE_SUFFIXES[unit]}`;
}
