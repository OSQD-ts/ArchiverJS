/**
 * The failure paths — what happens when the disk is full, the process died
 * mid-rotation, or the log is one somebody deliberately made private.
 */

import { chmod, lstat, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveFailedError, SourceLockedError } from '../src/errors.js';
import { every, size } from '../src/triggers.js';
import { Source } from '../src/source.js';
import { LocalFileStore } from '../src/store.js';
import type { ArchiveStore } from '../src/types.js';
import { POSIX, spawnIdleProcess, tempDir } from './helpers.js';

/** A store that always fails, standing in for a full disk or an outage. */
const brokenStore: ArchiveStore = {
  name: 'broken',
  has: async () => false,
  list: async () => [],
  remove: async () => {},
  put: async () => {
    throw new Error('ENOSPC: no space left on device');
  },
};

describe('a failing store', () => {
  it.each(['rename', 'copy-truncate'] as const)(
    'never destroys the contents (%s)',
    async (strategy) => {
      const dir = await tempDir();
      const path = join(dir, 'app.log');
      await writeFile(path, 'IRREPLACEABLE AUDIT TRAIL\n');

      const source = new Source({ path, strategy, store: brokenStore, compress: 'none' });
      const error = (await source.archive().catch((e: unknown) => e)) as ArchiveFailedError;

      expect(error).toBeInstanceOf(ArchiveFailedError);
      // Either the file was put back, or the error says exactly where the bytes are.
      const live = await readFile(path, 'utf8');
      const preserved =
        live === 'IRREPLACEABLE AUDIT TRAIL\n'
          ? live
          : await readFile(error.retained!, 'utf8');
      expect(preserved).toBe('IRREPLACEABLE AUDIT TRAIL\n');
    },
  );

  it('puts a renamed file straight back when nothing has taken its place', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n');

    const source = new Source({ path, store: brokenStore, compress: 'none' });
    const error = (await source.archive().catch((e: unknown) => e)) as ArchiveFailedError;

    expect(error.retained).toBeNull();
    expect(await readFile(path, 'utf8')).toBe('body\n');
    expect(await readdir(dir)).toEqual(['app.log']);
  });
});

describe('a detach that fails halfway', () => {
  it.skipIf(!POSIX || process.getuid?.() === 0)(
    'leaves nothing behind that a later run would archive twice',
    async () => {
      const dir = await tempDir();
      const path = join(dir, 'app.log');
      const archiveDir = join(dir, 'archive');
      await writeFile(path, 'AUDIT LINE\n');
      // Readable but not writable: the copy succeeds, the `r+` open that
      // precedes the truncate does not. That is the window where the temporary
      // file is a duplicate of data the live file still holds.
      await chmod(path, 0o444);

      const source = new Source({
        path,
        strategy: 'copy-truncate',
        compress: 'none',
        destination: archiveDir,
        filename: '{name}.{index}{ext}',
        retention: false,
      });

      await expect(source.archive()).rejects.toBeInstanceOf(ArchiveFailedError);

      // The live file is untouched, and no half-written copy survives to be
      // adopted later — archiving the same lines twice is as wrong as losing
      // them.
      expect(await readFile(path, 'utf8')).toBe('AUDIT LINE\n');
      expect((await readdir(dir)).filter((entry) => entry.includes('.archiving-'))).toEqual([]);

      await chmod(path, 0o644);
      await source.archive();
      expect(await readdir(archiveDir)).toEqual(['app.1.log']);
    },
  );

  it('reports nothing as retained when it cleaned up after itself', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n');

    const source = new Source({
      path,
      strategy: 'copy-truncate',
      compress: 'none',
      // A destination that cannot be created, so the run fails after the
      // truncate rather than before it.
      store: brokenStore,
    });
    const error = (await source.archive().catch((e: unknown) => e)) as ArchiveFailedError;

    // Here the bytes really did leave the file, so they are kept and named.
    expect(error.retained).not.toBeNull();
    expect(await readFile(error.retained!, 'utf8')).toBe('body\n');
  });
});

describe('recovering from a crash', () => {
  it('archives contents a previous run left behind, oldest first', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const archiveDir = join(dir, 'archive');

    // Debris from a run that died after detaching: our own pid, so it is ours
    // to adopt.
    await writeFile(join(dir, `app.log.archiving-${process.pid}-1`), 'older\n');
    await writeFile(path, 'current\n');

    const source = new Source({
      path,
      compress: 'none',
      destination: archiveDir,
      filename: '{name}.{index}{ext}',
      retention: false,
    });
    await source.archive();

    const archives = (await readdir(archiveDir)).sort();
    expect(archives).toEqual(['app.1.log', 'app.2.log']);
    // Chronological: the rescued contents come before the fresh ones.
    expect(await readFile(join(archiveDir, 'app.1.log'), 'utf8')).toBe('older\n');
    expect(await readFile(join(archiveDir, 'app.2.log'), 'utf8')).toBe('current\n');
    // And the debris is gone.
    expect(await readdir(dir)).toEqual(['app.log', 'archive']);
  });

  it('leaves alone a file another live archiver is working on', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    // A real process that is not us — the check the code actually makes.
    const foreign = join(dir, `app.log.archiving-${await spawnIdleProcess()}-1`);
    await writeFile(foreign, 'someone else is mid-rotation\n');
    await writeFile(path, 'ours\n');

    const source = new Source({ path, compress: 'none', destination: join(dir, 'archive') });
    await source.archive();

    expect(await readFile(foreign, 'utf8')).toBe('someone else is mid-rotation\n');
    expect(await readdir(join(dir, 'archive'))).toHaveLength(1);
  });

  it('sweeps away empty debris rather than archiving nothing', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(join(dir, `app.log.archiving-${process.pid}-2`), '');
    await writeFile(path, 'content\n');

    const source = new Source({ path, compress: 'none', destination: join(dir, 'archive') });
    await source.archive();

    expect(await readdir(join(dir, 'archive'))).toHaveLength(1);
    expect(await readdir(dir)).toEqual(['app.log', 'archive']);
  });
});

describe.skipIf(!POSIX)('permissions', () => {
  it('keeps a private log private once archived', async () => {
    const dir = await tempDir();
    const path = join(dir, 'secrets.log');
    await writeFile(path, 'bearer tokens and worse\n', { mode: 0o600 });

    const result = await new Source({
      path,
      compress: 'none',
      destination: join(dir, 'archive'),
    }).archive();

    // The umask would have produced 0644 here — a world-readable copy of a file
    // its owner deliberately locked down.
    expect((await stat(result.archive.location)).mode & 0o777).toBe(0o600);
  });

  it('honours an explicit store mode over the source', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n', { mode: 0o600 });

    const result = await new Source({
      path,
      compress: 'none',
      store: new LocalFileStore(join(dir, 'archive'), { mode: 0o640 }),
    }).archive();

    expect((await stat(result.archive.location)).mode & 0o777).toBe(0o640);
  });
});

describe.skipIf(!POSIX)('symlinked sources', () => {
  it('rotates the file the link points at and leaves the link alone', async () => {
    const dir = await tempDir();
    const target = join(dir, 'app.2026.log');
    const link = join(dir, 'app.log');
    await writeFile(target, 'through the link\n');
    await symlink(target, link);

    const result = await new Source({
      path: link,
      compress: 'none',
      destination: join(dir, 'archive'),
    }).archive();

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('');
    expect(await readFile(result.archive.location, 'utf8')).toBe('through the link\n');
  });
});

describe('locking', () => {
  it('refuses to rotate a file another live process holds', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n');
    // A lock held by pid 1: always alive, never us.
    await writeFile(
      `${path}.archiving.lock`,
      JSON.stringify({ pid: await spawnIdleProcess(), host: hostname(), since: Date.now() }),
    );

    const source = new Source({
      path,
      when: size(1),
      compress: 'none',
      destination: join(dir, 'archive'),
    });

    const outcome = await source.check(Date.now());
    expect(outcome).toMatchObject({ archived: false, reason: 'locked' });
    // Nothing was touched.
    expect(await readFile(path, 'utf8')).toBe('body\n');
    await expect(source.archive()).rejects.toMatchObject({ cause: expect.any(SourceLockedError) });
  });

  it('takes over a lock left behind by a process that is gone', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n');
    // A pid that cannot exist, as if the owner crashed mid-rotation.
    await writeFile(
      `${path}.archiving.lock`,
      JSON.stringify({ pid: 0x7ffffff0, host: hostname(), since: Date.now() }),
    );

    const result = await new Source({
      path,
      compress: 'none',
      destination: join(dir, 'archive'),
    }).archive();

    expect(await readFile(result.archive.location, 'utf8')).toBe('body\n');
    // The lock is released, not leaked.
    expect(await readdir(dir)).toEqual(['app.log', 'archive']);
  });

  it('serializes two archivers pointed at the same file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const destination = join(dir, 'archive');
    await writeFile(path, 'x'.repeat(500));

    // Separate Source instances, as two processes would have.
    const a = new Source({ path, compress: 'none', destination, filename: '{name}.{index}{ext}' });
    const b = new Source({ path, compress: 'none', destination, filename: '{name}.{index}{ext}' });
    const [first, second] = await Promise.allSettled([a.archive(), b.archive()]);

    // One wins; the other is told to come back later. Never two archives of the
    // same 500 bytes, and never an interleaved one.
    const winners = [first, second].filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect(await readdir(destination)).toHaveLength(1);
    expect(await readFile(join(destination, 'app.1.log'), 'utf8')).toBe('x'.repeat(500));
  });

  it('can be turned off', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n');
    await writeFile(
      `${path}.archiving.lock`,
      JSON.stringify({ pid: await spawnIdleProcess(), host: hostname(), since: Date.now() }),
    );

    const source = new Source({
      path,
      lock: false,
      compress: 'none',
      destination: join(dir, 'archive'),
    });
    await expect(source.archive()).resolves.toBeTruthy();
  });
});

describe('surviving a restart', () => {
  it('recovers the rotation cadence from the archives already stored', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const destination = join(dir, 'archive');
    await writeFile(path, 'first\n');

    // First "process": rotates once.
    await new Source({ path, compress: 'none', destination }).archive();

    // Second "process": brand new object, no memory of the first.
    await writeFile(path, 'second\n');
    const restarted = new Source({
      path,
      compress: 'none',
      destination,
      when: every('1h'),
    });

    // The archive on disk is minutes old, so an hourly cadence is not due yet.
    expect(await restarted.check(Date.now())).toMatchObject({
      archived: false,
      reason: 'no-trigger',
    });
    // …and is due once an hour has passed, rather than firing immediately or
    // never, which is what an in-memory-only anchor would have produced.
    expect(await restarted.check(Date.now() + 3_600_000)).toMatchObject({ archived: true });
  });
});

describe('retention failures', () => {
  it('do not fail a run whose archive is already safely stored', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n');

    const inner = new LocalFileStore(join(dir, 'archive'));
    const store: ArchiveStore = {
      name: 'prune-hostile',
      put: (key, body, metadata) => inner.put(key, body, metadata),
      has: (key) => inner.has(key),
      list: async () => {
        throw new Error('listing is down');
      },
      remove: async () => {
        throw new Error('delete is down');
      },
    };

    // The archive lands; only the cleanup afterwards fails. Failing the whole
    // run here would invite a retry, and a retry would store the bytes twice.
    const result = await new Source({ path, compress: 'none', store }).archive();

    expect(result.pruned).toEqual([]);
    expect(await readFile(result.archive.location, 'utf8')).toBe('body\n');
    expect(await readFile(path, 'utf8')).toBe('');
  });
});
