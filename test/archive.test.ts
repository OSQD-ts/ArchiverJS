import { appendFile, chmod, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { archiveFile } from '../src/archiver.js';
import { ArchiveFailedError } from '../src/errors.js';
import { Source } from '../src/source.js';
import { POSIX, tempDir } from './helpers.js';

describe('archiving a file', () => {
  it('compresses the contents and leaves an empty live file behind', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const body = 'line\n'.repeat(1000);
    await writeFile(path, body);

    const result = await archiveFile(path, { destination: join(dir, 'archive') });

    expect(result.compression).toBe('gzip');
    expect(result.sourceBytes).toBe(body.length);
    expect(result.archiveBytes).toBeLessThan(body.length);
    expect(gunzipSync(await readFile(result.archive.location)).toString()).toBe(body);
    expect((await stat(path)).size).toBe(0);
    expect(result.archive.key).toMatch(/^app-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.log\.gz$/);
  });

  it('stores the bytes verbatim when compression is off', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'hello');

    const result = await archiveFile(path, { compress: 'none' });

    expect(result.archive.key).toBe(result.archive.key.replace(/\.(gz|br|zst)$/, ''));
    expect(await readFile(result.archive.location, 'utf8')).toBe('hello');
  });

  it.each(['brotli', 'deflate'] as const)('round-trips through %s', async (method) => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'compress me');
    const result = await archiveFile(path, { compress: method });
    expect(await stat(result.archive.location)).toBeTruthy();
  });

  it.skipIf(!POSIX).each([0o640, 0o666, 0o600])(
    'preserves file mode %o across a rotation',
    async (mode) => {
      const dir = await tempDir();
      const path = join(dir, 'app.log');
      await writeFile(path, 'x'.repeat(64));
      await chmod(path, mode);

      await archiveFile(path, { destination: join(dir, 'archive') });

      // 0o666 is the one that matters: `open`'s mode argument is filtered by the
      // umask, so a naive recreate hands the writer back a narrower file.
      expect((await stat(path)).mode & 0o777).toBe(mode);
    },
  );

  it('never leaves a half-written archive under its final name', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const archiveDir = join(dir, 'archive');
    await writeFile(path, 'x'.repeat(64));

    const source = new Source({
      path,
      compress: 'none',
      destination: archiveDir,
      // A codec that dies partway through, standing in for a crash or a full disk.
      filename: '{name}{ext}',
    });
    const broken = new Source({
      path,
      compress: {
        name: 'explodes',
        extension: '.bad',
        createCompressor: () =>
          new Transform({
            transform(_chunk, _encoding, callback) {
              callback(new Error('disk is full'));
            },
          }),
      },
      destination: archiveDir,
    });

    await expect(broken.archive()).rejects.toBeInstanceOf(ArchiveFailedError);

    // Neither the staging file nor a truncated archive survives the failure.
    expect(await readdir(archiveDir)).toEqual([]);
    // And the source is intact, so the next run has something to archive.
    expect((await readFile(path, 'utf8')).length).toBe(64);
    await expect(source.archive()).resolves.toBeTruthy();
  });

  it('keeps a writer with an open descriptor working under copy-truncate', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'before\n');
    // A foreign process holding an append-mode descriptor across the rotation.
    const writer = await open(path, 'a');
    try {
      const result = await archiveFile(path, {
        strategy: 'copy-truncate',
        compress: 'none',
        destination: join(dir, 'archive'),
      });
      await writer.appendFile('after\n');

      expect(await readFile(result.archive.location, 'utf8')).toBe('before\n');
      // The inode is the same one the writer holds, so the new line lands in it.
      expect(await readFile(path, 'utf8')).toBe('after\n');
    } finally {
      await writer.close();
    }
  });

  it('carries bytes appended during a copy-truncate into the archive, in order', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'first\n');

    const source = new Source({ path, strategy: 'copy-truncate', compress: 'none' });
    // Simulate a writer that appends between the size measurement and the
    // copy. (The multi-buffer drain loop itself is covered deterministically in
    // fs.test.ts; this checks the strategy end to end.)
    const archiving = source.archive('test');
    await appendFile(path, 'second\n');
    const result = await archiving;

    // Nothing is lost and nothing is reordered: the drain keeps chasing the
    // writer until the file stops growing, then truncates.
    expect(await readFile(result.archive.location, 'utf8')).toBe('first\nsecond\n');
    expect(await readFile(path, 'utf8')).toBe('');
  });

  it('never overwrites an existing archive', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const source = new Source({
      path,
      compress: 'none',
      filename: '{name}{ext}',
      destination: join(dir, 'archive'),
    });

    await writeFile(path, 'one');
    const first = await source.archive();
    await writeFile(path, 'two');
    const second = await source.archive();

    expect(first.archive.key).toBe('app.log');
    expect(second.archive.key).toBe('app.log.1');
    expect(await readFile(first.archive.location, 'utf8')).toBe('one');
    expect(await readFile(second.archive.location, 'utf8')).toBe('two');
  });

  it('numbers archives when the template asks for an index', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const source = new Source({
      path,
      compress: 'none',
      filename: '{name}.{index}{ext}',
      destination: join(dir, 'archive'),
    });

    for (const body of ['a', 'b', 'c']) {
      await writeFile(path, body);
      await source.archive();
    }

    expect((await readdir(join(dir, 'archive'))).sort()).toEqual([
      'app.1.log',
      'app.2.log',
      'app.3.log',
    ]);
  });

  it('applies retention after each run', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const archiveDir = join(dir, 'archive');
    const source = new Source({
      path,
      compress: 'none',
      destination: archiveDir,
      filename: '{name}.{index}{ext}',
      retention: { maxFiles: 2 },
    });

    for (const body of ['a', 'b', 'c', 'd']) {
      await writeFile(path, body);
      await source.archive();
    }

    const kept = (await readdir(archiveDir)).sort();
    expect(kept).toHaveLength(2);
    expect(kept).toEqual(['app.3.log', 'app.4.log']);
  });

  it('only prunes files its own template could have produced', async () => {
    const dir = await tempDir();
    const archiveDir = join(dir, 'archive');
    const path = join(dir, 'app.log');
    const source = new Source({
      path,
      compress: 'none',
      destination: archiveDir,
      retention: { maxFiles: 1 },
    });

    await writeFile(path, 'a');
    await source.archive();
    await writeFile(join(archiveDir, 'quarterly-report.tar'), 'precious');
    await writeFile(path, 'b');
    await source.archive();

    expect(await readFile(join(archiveDir, 'quarterly-report.tar'), 'utf8')).toBe('precious');
  });

  it('restores the file when the store rejects the archive', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'precious data');

    const source = new Source({
      path,
      compress: 'none',
      store: {
        name: 'broken',
        has: async () => false,
        list: async () => [],
        remove: async () => {},
        put: async () => {
          throw new Error('store is down');
        },
      },
    });

    await expect(source.archive()).rejects.toBeInstanceOf(ArchiveFailedError);
    expect(await readFile(path, 'utf8')).toBe('precious data');
  });

  it('shares one run between concurrent callers', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body');
    const source = new Source({ path, compress: 'none' });

    const [a, b] = await Promise.all([source.archive(), source.archive()]);

    expect(a.archive.key).toBe(b.archive.key);
    expect(source.busy).toBe(false);
  });
});

describe('checking a source', () => {
  it('reports why it did nothing', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const source = new Source({ path });

    expect(await source.check()).toMatchObject({ archived: false, reason: 'missing' });

    await writeFile(path, '');
    expect(await source.check()).toMatchObject({ archived: false, reason: 'too-small' });

    await writeFile(path, 'small');
    expect(await source.check()).toMatchObject({ archived: false, reason: 'no-trigger' });
  });
});
