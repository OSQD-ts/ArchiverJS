/**
 * `onDetached` exists to shrink a real window: under `rename`, a writer that
 * still holds the old descriptor keeps writing into the file we are about to
 * archive and delete. The hook has to fire before any of that work starts, or
 * it is no better than the `archived` event.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createArchiver } from '../src/archiver.js';
import { Source } from '../src/source.js';
import { LocalFileStore } from '../src/store.js';
import { createRotatingStream } from '../src/stream.js';
import { size } from '../src/triggers.js';
import type { ArchiveStore, DetachedInfo } from '../src/types.js';
import { tempDir } from './helpers.js';

describe('onDetached', () => {
  it('fires once the bytes are out and before anything is stored', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const archiveDir = join(dir, 'archive');
    await writeFile(path, 'contents\n');

    const observed: Array<{
      info: DetachedInfo;
      liveBody: string;
      detachedBody: string;
      archivesYet: number;
    }> = [];
    const source = new Source({
      path,
      compress: 'none',
      destination: archiveDir,
      onDetached: async (info) => {
        observed.push({
          info,
          // The live file is already replaced — this is the instant a writer
          // should be told to reopen.
          liveBody: await readFile(path, 'utf8'),
          // Read here: by the time the run returns this file is gone, which is
          // itself the point — the hook is the only moment it exists.
          detachedBody: await readFile(info.detachedPath, 'utf8'),
          archivesYet: (await readdir(archiveDir).catch(() => [])).length,
        });
      },
    });

    await source.archive();

    expect(observed).toHaveLength(1);
    const [first] = observed;
    expect(first!.liveBody).toBe('');
    expect(first!.archivesYet).toBe(0);
    expect(first!.info).toMatchObject({
      source: 'app.log',
      path,
      bytes: 'contents\n'.length,
      strategy: 'rename',
    });
    expect(first!.detachedBody).toBe('contents\n');
  });

  it('is awaited, so a slow reopen finishes before the archive is read', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'contents\n');
    const order: string[] = [];

    const inner = new LocalFileStore(join(dir, 'archive'));
    const store: ArchiveStore = {
      name: 'ordered',
      has: (key) => inner.has(key),
      list: (prefix) => inner.list(prefix),
      remove: (archive) => inner.remove(archive),
      put: (key, body, metadata) => {
        order.push('put');
        return inner.put(key, body, metadata);
      },
    };

    await new Source({
      path,
      compress: 'none',
      store,
      onDetached: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('hook');
      },
    }).archive();

    expect(order).toEqual(['hook', 'put']);
  });

  it('reports a throwing hook as a warning without failing the archive', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'contents\n');
    const warnings: Error[] = [];

    const result = await new Source({
      path,
      compress: 'none',
      destination: join(dir, 'archive'),
      onDetached: () => {
        // Signalling a writer that has already exited throws ESRCH, and that
        // must not cost anyone their log.
        throw new Error('ESRCH: no such process');
      },
      onWarning: (error) => warnings.push(error),
    }).archive();

    expect(await readFile(result.archive.location, 'utf8')).toBe('contents\n');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('ESRCH');
    expect(warnings[0]!.message).toContain('onDetached');
  });

  it('reaches the archiver as a warning event', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'x'.repeat(200));
    const warnings: Error[] = [];

    const archiver = createArchiver({
      sources: [
        {
          path,
          when: size(100),
          compress: 'none',
          destination: join(dir, 'archive'),
          onDetached: () => {
            throw new Error('hook exploded');
          },
        },
      ],
    });
    archiver.on('warning', (error) => warnings.push(error));

    const [outcome] = await archiver.check();
    expect(outcome).toMatchObject({ archived: true });
    expect(warnings[0]!.message).toContain('hook exploded');
  });

  it('reaches a rotating stream as a warning event', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const warnings: Error[] = [];

    const stream = createRotatingStream({
      path,
      when: size(10),
      compress: 'none',
      destination: join(dir, 'archive'),
      checkInterval: 0,
      onDetached: () => {
        throw new Error('hook exploded');
      },
    });
    stream.on('warning', (error) => warnings.push(error));

    await new Promise<void>((resolve, reject) =>
      stream.write('first line\n', (error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      stream.write('second line\n', (error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve) => stream.end(resolve));

    expect(warnings[0]!.message).toContain('hook exploded');
  });

  it('lets a failed retention delete surface as a warning too', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n');
    const warnings: Error[] = [];

    const inner = new LocalFileStore(join(dir, 'archive'));
    const store: ArchiveStore = {
      name: 'undeletable',
      put: (key, body, metadata) => inner.put(key, body, metadata),
      has: (key) => inner.has(key),
      list: (prefix) => inner.list(prefix),
      remove: async () => {
        throw new Error('read-only bucket');
      },
    };

    await new Source({
      path,
      compress: 'none',
      store,
      retention: { maxFiles: 0 },
      onWarning: (error) => warnings.push(error),
    }).archive();

    expect(warnings[0]!.message).toContain('read-only bucket');
    expect(warnings[0]!.message).toContain('retention');
  });

  it('does not invent a hook call when none was configured', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'body\n');
    const warn = vi.fn();

    await new Source({
      path,
      compress: 'none',
      destination: join(dir, 'archive'),
      onWarning: warn,
    }).archive();

    expect(warn).not.toHaveBeenCalled();
  });
});
