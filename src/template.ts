/**
 * Archive filename templating.
 *
 * Timestamps are rendered from local time and shaped to be filename-safe and
 * lexicographically sortable, so `ls` in the archive directory reads as a
 * timeline.
 */

import { ArchiverConfigError } from './errors.js';
import type { NameContext, NameTemplate } from './types.js';

/** Default archive filename: `app-2026-09-05T14-31-07.log.gz`. */
export const DEFAULT_TEMPLATE = '{name}-{timestamp}{ext}{compressExt}';

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

function tokens(context: NameContext): Record<string, string> {
  const d = context.date;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return {
    name: context.name,
    ext: context.ext,
    compressExt: context.compressExt,
    date,
    time,
    timestamp: `${date}T${time}`,
    epoch: String(d.getTime()),
    index: String(context.index),
    // Zero-padded index, for archives that must sort as text.
    seq: pad(context.index, 3),
    pid: String(process.pid),
  };
}

/** Render a template. Unknown `{tokens}` are a configuration error, not silent output. */
export function renderName(template: NameTemplate, context: NameContext): string {
  if (typeof template === 'function') return sanitize(template(context));
  const values = tokens(context);
  const rendered = template.replace(/\{(\w+)\}/g, (_match, token: string) => {
    const value = values[token];
    if (value === undefined) {
      throw new ArchiverConfigError(
        `filename: unknown token '{${token}}' (available: ${Object.keys(values).join(', ')})`,
      );
    }
    return value;
  });
  return sanitize(rendered);
}

/**
 * Keep a rendered name to a single path segment. A template is config, but the
 * values fed into a function template may not be, and an archive must never
 * escape its destination directory.
 */
function sanitize(name: string): string {
  const flattened = name.replace(/[/\\]+/g, '_').replace(/\0/g, '');
  if (flattened === '' || flattened === '.' || flattened === '..') {
    throw new ArchiverConfigError(`filename: template produced an unusable name '${name}'`);
  }
  return flattened;
}

/** Split `app.log` into `{ name: 'app', ext: '.log' }`; dotfiles keep their leading dot. */
export function splitName(basename: string): { name: string; ext: string } {
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return { name: basename, ext: '' };
  return { name: basename.slice(0, dot), ext: basename.slice(dot) };
}

/** Regex fragments for the varying tokens, used to recognize our own archives. */
const TOKEN_PATTERNS: Record<string, string> = {
  date: '\\d{4}-\\d{2}-\\d{2}',
  time: '\\d{2}-\\d{2}-\\d{2}',
  timestamp: '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}',
  epoch: '\\d+',
  pid: '\\d+',
  // Capturing, so an existing archive can tell us which number it holds.
  index: '(\\d+)',
  seq: '(\\d+)',
};

/** Every suffix a built-in codec can add, so archives written earlier with a different one still match. */
const ANY_COMPRESS_EXT = '(?:\\.gz|\\.br|\\.zst|\\.zz)?';

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a matcher for the archives a source produces.
 *
 * Retention deletes files, so it must never guess: only names this template
 * could actually have produced are candidates. Function templates are
 * unknowable, hence `null` — the archiver then prunes only what it recorded
 * itself during this process's lifetime.
 *
 * `{index}` / `{seq}` become capture group 1, which is how {@link readIndex}
 * recovers the sequence number after a restart.
 */
export function nameMatcher(template: NameTemplate, name: string, ext: string): RegExp | null {
  if (typeof template === 'function') return null;
  let pattern = '';
  let cursor = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    pattern += escapeRe(template.slice(cursor, match.index));
    const token = match[1]!;
    if (token === 'name') pattern += escapeRe(name);
    else if (token === 'ext') pattern += escapeRe(ext);
    else if (token === 'compressExt') pattern += ANY_COMPRESS_EXT;
    else if (TOKEN_PATTERNS[token] !== undefined) pattern += TOKEN_PATTERNS[token];
    else return null;
    cursor = match.index + match[0].length;
  }
  pattern += escapeRe(template.slice(cursor));
  // `.1`, `.2`, … are appended by collision handling in the store.
  return new RegExp(`^${pattern}(?:\\.\\d+)?$`);
}

/**
 * The literal text a template always starts with, used to narrow a store
 * listing cheaply. Returns `''` when the very first thing is a variable token.
 */
export function literalPrefix(template: NameTemplate, name: string, ext: string): string {
  if (typeof template === 'function') return '';
  const firstToken = template.indexOf('{');
  if (firstToken === -1) return template;
  let prefix = template.slice(0, firstToken);
  // A leading `{name}`/`{ext}` is still literal, so keep walking through them.
  let rest = template.slice(firstToken);
  for (;;) {
    const match = /^\{(\w+)\}/.exec(rest);
    if (!match) break;
    const token = match[1]!;
    if (token === 'name') prefix += name;
    else if (token === 'ext') prefix += ext;
    else break;
    rest = rest.slice(match[0].length);
    const next = rest.indexOf('{');
    if (next === -1) return prefix + rest;
    prefix += rest.slice(0, next);
    rest = rest.slice(next);
  }
  return prefix;
}

/** The `{index}` an archive filename carries, or `null` if the template has none. */
export function readIndex(matcher: RegExp, key: string): number | null {
  const match = matcher.exec(key);
  const captured = match?.[1];
  return captured === undefined ? null : Number(captured);
}
