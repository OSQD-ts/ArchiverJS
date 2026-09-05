import { describe, expect, it } from 'vitest';
import { ArchiverConfigError } from '../src/errors.js';
import { formatBytes, parseDuration, parseSize } from '../src/units.js';

describe('parseSize', () => {
  it('passes numbers through as bytes', () => {
    expect(parseSize(2048)).toBe(2048);
  });

  it('parses binary units case-insensitively', () => {
    expect(parseSize('10mb')).toBe(10 * 1024 * 1024);
    expect(parseSize('10 MiB')).toBe(10 * 1024 * 1024);
    expect(parseSize('1.5kb')).toBe(1536);
    expect(parseSize('512')).toBe(512);
  });

  it('rejects nonsense instead of guessing', () => {
    expect(() => parseSize('10 bananas')).toThrow(ArchiverConfigError);
    expect(() => parseSize('10mb of logs')).toThrow(ArchiverConfigError);
    expect(() => parseSize(-1)).toThrow(ArchiverConfigError);
    expect(() => parseSize('')).toThrow(ArchiverConfigError);
  });
});

describe('parseDuration', () => {
  it('parses single and compound durations', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration(250)).toBe(250);
  });

  it('rejects unknown units', () => {
    expect(() => parseDuration('3 fortnights')).toThrow(ArchiverConfigError);
  });
});

describe('formatBytes', () => {
  it('scales to binary suffixes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.50 KiB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20.0 MiB');
  });
});
