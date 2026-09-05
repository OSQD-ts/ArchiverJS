/**
 * The paths that only run when something unusual happens.
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createArchiver } from '../src/archiver.js';
import { ArchiverConfigError } from '../src/errors.js';
import { copyPrefix, syncDirectory, touch } from '../src/internal/fs.js';
import { LocalFileStore } from '../src/store.js';
import { renderName } from '../src/template.js';
import { size } from '../src/triggers.js';
import type { StoredArchive } from '../src/types.js';
import { parseDuration, parseSize } from '../src/units.js';
import { POSIX, spawnIdleProcess, tempDir } from './helpers.js';

describe('managing sources at runtime', () => {
  it('adds, finds and removes them', async () => {
    const dir = await tempDir();
    const archiver = createArchiver({ sources: [{ path: join(dir, 'a.log') }] });

    const added = archiver.add({ path: join(dir, 'b.log'), name: 'b' });
    expect(added.name).toBe('b');
    expect(archiver.get('b')).toBe(added);
    expect(archiver.sources.map((s) => s.name)).toEqual(['a.log', 'b']);

    expect(archiver.remove('b')).toBe(true);
    expect(archiver.remove('b')).toBe(false);
    expect(archiver.get('b')).toBeUndefined();
  });

  it('applies defaults to a source added later', async () => {
    const dir = await tempDir();
    const archiver = createArchiver({
      sources: [{ path: join(dir, 'a.log') }],
      defaults: { compress: 'brotli' },
    });
    expect(archiver.add({ path: join(dir, 'b.log') }).codec.name).toBe('brotli');
  });

  it('rejects a checkInterval below a millisecond', () => {
    expect(() => createArchiver({ sources: [{ path: '/tmp/a.log' }], checkInterval: 0 })).toThrow(
      ArchiverConfigError,
    );
  });
});

describe('events', () => {
  it('reports a listener that throws instead of letting it escape', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'x'.repeat(200));

    const archiver = createArchiver({
      sources: [{ path, when: size(100), compress: 'none', destination: join(dir, 'archive') }],
    });
    const failures: Error[] = [];
    archiver.on('error', (error) => failures.push(error));
    archiver.on('archived', () => {
      throw new Error('my metrics client is broken');
    });

    await archiver.check();
    // The listener blew up; the archive still happened.
    await vi.waitFor(() => expect(failures[0]?.message).toBe('my metrics client is broken'));
  });

  it('announces pruning separately from archiving', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const archiver = createArchiver({
      sources: [
        {
          path,
          name: 'app',
          compress: 'none',
          destination: join(dir, 'archive'),
          filename: '{name}.{index}{ext}',
          retention: { maxFiles: 1 },
        },
      ],
    });

    const pruned: StoredArchive[] = [];
    archiver.on('pruned', ({ removed }) => pruned.push(...removed));

    await writeFile(path, 'one');
    await archiver.archive('app');
    await writeFile(path, 'two');
    await archiver.archive('app');

    expect(pruned.map((archive) => archive.key)).toEqual(['app.1.log']);
  });
});

describe('the local store', () => {
  it('reports an empty listing for a directory that is not there yet', async () => {
    const dir = await tempDir();
    const store = new LocalFileStore(join(dir, 'not-created-yet'));
    expect(await store.list('')).toEqual([]);
    expect(await store.has('anything')).toBe(false);
  });

  it('ignores subdirectories when listing archives', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'app-1.log'), 'a');

    const store = new LocalFileStore(dir);
    expect((await store.list('')).map((a) => a.key)).toEqual(['app-1.log']);
  });

  it('removing an archive that is already gone is not an error', async () => {
    const dir = await tempDir();
    const store = new LocalFileStore(dir);
    await expect(
      store.remove({ key: 'x', location: join(dir, 'x'), bytes: 0, createdAt: 0 }),
    ).resolves.toBeUndefined();
  });

  it.skipIf(!POSIX)('propagates a real listing failure rather than swallowing it', async () => {
    const dir = await tempDir();
    const unreadable = join(dir, 'locked');
    await mkdir(unreadable);
    await writeFile(join(unreadable, 'app-1.log'), 'a');
    await chmod(unreadable, 0o000);

    const store = new LocalFileStore(unreadable);
    try {
      // Root ignores permission bits, so only assert where they bite.
      if (process.getuid?.() !== 0) await expect(store.list('')).rejects.toThrow();
    } finally {
      await chmod(unreadable, 0o755);
      await rm(unreadable, { recursive: true, force: true });
    }
  });
});

describe('filesystem helpers', () => {
  it('copies a zero-length prefix as an empty file', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'from'), 'ignored');
    await copyPrefix(join(dir, 'from'), join(dir, 'to'), 0);
    expect(await readFile(join(dir, 'to'), 'utf8')).toBe('');
  });

  it('touch creates missing parents', async () => {
    const dir = await tempDir();
    await touch(join(dir, 'deeply', 'nested', 'file.log'));
    expect(await readFile(join(dir, 'deeply', 'nested', 'file.log'), 'utf8')).toBe('');
  });

  it('syncing a directory that cannot be opened is not an error', async () => {
    const dir = await tempDir();
    await expect(syncDirectory(join(dir, 'does-not-exist'))).resolves.toBeUndefined();
    await expect(syncDirectory(dir)).resolves.toBeUndefined();
  });
});

describe('input validation', () => {
  it('rejects sizes and durations that are not finite', () => {
    expect(() => parseSize(Number.NaN)).toThrow(ArchiverConfigError);
    expect(() => parseSize(Number.POSITIVE_INFINITY)).toThrow(ArchiverConfigError);
    expect(() => parseDuration(-5)).toThrow(ArchiverConfigError);
    expect(() => parseDuration(Number.NaN)).toThrow(ArchiverConfigError);
  });

  it('rejects a template that renders to nothing usable', () => {
    const context = { name: '.', ext: '', date: new Date(), index: 1, compressExt: '' };
    expect(() => renderName('{name}', context)).toThrow(ArchiverConfigError);
    expect(() => renderName(() => '', context)).toThrow(ArchiverConfigError);
    expect(() => renderName(() => '..', context)).toThrow(ArchiverConfigError);
  });

  it('flattens a path a function template tried to build', () => {
    const context = { name: 'app', ext: '.log', date: new Date(), index: 1, compressExt: '' };
    // Escaping the destination is not an option, so separators collapse.
    expect(renderName(() => '../../etc/passwd', context)).toBe('.._.._etc_passwd');
    expect(renderName(() => '2026/app.log', context)).toBe('2026_app.log');
  });

  it('names the lock holder in a way a human can read', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'x'.repeat(200));
    await writeFile(
      `${path}.archiving.lock`,
      JSON.stringify({ pid: await spawnIdleProcess(), host: hostname(), since: Date.now() }),
    );

    const archiver = createArchiver({
      sources: [{ path, when: size(1), compress: 'none', destination: join(dir, 'archive') }],
    });
    const skipped: string[] = [];
    archiver.on('skipped', (info) => skipped.push(info.reason));

    await archiver.archiveAll();
    expect(skipped).toContain('locked');
  });
});
