import { describe, expect, it } from 'vitest';
import { ArchiverConfigError } from '../src/errors.js';
import {
  DEFAULT_TEMPLATE,
  literalPrefix,
  nameMatcher,
  renderName,
  splitName,
} from '../src/template.js';

const context = {
  name: 'app',
  ext: '.log',
  date: new Date(2026, 8, 5, 14, 31, 7),
  index: 3,
  compressExt: '.gz',
};

describe('renderName', () => {
  it('renders the default template as a sortable name', () => {
    expect(renderName(DEFAULT_TEMPLATE, context)).toBe('app-2026-09-05T14-31-07.log.gz');
  });

  it('supports the individual tokens', () => {
    expect(renderName('{name}.{date}.{index}{compressExt}', context)).toBe('app.2026-09-05.3.gz');
    expect(renderName('{name}-{seq}{ext}', context)).toBe('app-003.log');
  });

  it('rejects unknown tokens', () => {
    expect(() => renderName('{name}-{nope}', context)).toThrow(ArchiverConfigError);
  });

  it('accepts a function and keeps its result inside one directory', () => {
    expect(renderName((c) => `../${c.name}.bak`, context)).toBe('.._app.bak');
  });
});

describe('nameMatcher', () => {
  it('matches only names the template could have produced', () => {
    const matcher = nameMatcher(DEFAULT_TEMPLATE, 'app', '.log')!;
    expect(matcher.test('app-2026-09-05T14-31-07.log.gz')).toBe(true);
    expect(matcher.test('app-2026-09-05T14-31-07.log')).toBe(true);
    expect(matcher.test('app-2026-09-05T14-31-07.log.gz.1')).toBe(true);
    expect(matcher.test('app.log')).toBe(false);
    expect(matcher.test('other-2026-09-05T14-31-07.log.gz')).toBe(false);
    expect(matcher.test('important-backup.tar')).toBe(false);
  });

  it('gives up on function templates rather than guessing', () => {
    expect(nameMatcher(() => 'x', 'app', '.log')).toBeNull();
  });
});

describe('literalPrefix', () => {
  it('walks through literal tokens', () => {
    expect(literalPrefix(DEFAULT_TEMPLATE, 'app', '.log')).toBe('app-');
    expect(literalPrefix('logs-{name}.{date}', 'app', '.log')).toBe('logs-app.');
    expect(literalPrefix('{date}-{name}', 'app', '.log')).toBe('');
  });
});

describe('splitName', () => {
  it('splits extensions but keeps dotfiles whole', () => {
    expect(splitName('app.log')).toEqual({ name: 'app', ext: '.log' });
    expect(splitName('app')).toEqual({ name: 'app', ext: '' });
    expect(splitName('.bashrc')).toEqual({ name: '.bashrc', ext: '' });
  });
});
