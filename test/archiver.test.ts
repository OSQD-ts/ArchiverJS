import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createArchiver } from '../src/archiver.js';
import { ArchiverConfigError } from '../src/errors.js';
import { size } from '../src/triggers.js';
import type { ArchiveResult } from '../src/types.js';
import { tempDir } from './helpers.js';

describe('Archiver', () => {
  it('archives the sources whose triggers fire and leaves the others alone', async () => {
    const dir = await tempDir();
    const big = join(dir, 'big.log');
    const small = join(dir, 'small.log');
    await writeFile(big, 'x'.repeat(200));
    await writeFile(small, 'x'.repeat(10));

    const archiver = createArchiver({
      sources: [{ path: big }, { path: small }],
      defaults: { when: size(100), compress: 'none', destination: join(dir, 'archive') },
    });
    const archived: ArchiveResult[] = [];
    archiver.on('archived', (result) => archived.push(result));

    const outcomes = await archiver.check();

    expect(archived).toHaveLength(1);
    expect(archived[0]?.source).toBe('big.log');
    expect(archived[0]?.reason).toBe('size>=100');
    expect(outcomes[1]).toMatchObject({ archived: false, reason: 'no-trigger' });
  });

  it('lets a source override the defaults', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'a.log'), 'x'.repeat(200));

    const archiver = createArchiver({
      sources: [{ path: join(dir, 'a.log'), compress: 'none' }],
      defaults: { when: size(100), compress: 'gzip' },
    });

    const [outcome] = await archiver.check();
    expect(outcome).toMatchObject({ archived: true });
    expect(outcome && 'result' in outcome && outcome.result.compression).toBe('none');
  });

  it('runs on an interval once started and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const dir = await tempDir();
      const path = join(dir, 'app.log');
      await writeFile(path, 'x'.repeat(200));

      const archiver = createArchiver({
        sources: [{ path, when: size(100), compress: 'none', destination: join(dir, 'archive') }],
        checkInterval: '1s',
      }).start();

      expect(archiver.running).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      await archiver.stop();
      expect(archiver.running).toBe(false);

      expect(await readdir(join(dir, 'archive'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports failures on the error event instead of throwing out of the loop', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'x'.repeat(200));

    const errors: Error[] = [];
    const archiver = createArchiver({
      sources: [
        {
          path,
          when: size(100),
          store: {
            name: 'broken',
            has: async () => false,
            list: async () => [],
            remove: async () => {},
            put: async () => {
              throw new Error('nope');
            },
          },
        },
      ],
      onError: (error) => errors.push(error),
    });

    await expect(archiver.check()).resolves.toHaveLength(0);
    expect(errors[0]?.message).toContain('nope');
  });

  it('archives on demand, whatever the triggers say', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'tiny');

    const archiver = createArchiver({
      sources: [{ path, name: 'app', when: size('1gb'), compress: 'none' }],
    });

    const result = await archiver.archive('app');
    expect(result.reason).toBe('manual');
    await expect(archiver.archive('nope')).rejects.toBeInstanceOf(ArchiverConfigError);
  });

  it('skips empty files when archiving everything', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'a.log'), 'content');
    await writeFile(join(dir, 'b.log'), '');

    const archiver = createArchiver({
      sources: [{ path: join(dir, 'a.log') }, { path: join(dir, 'b.log') }],
      defaults: { compress: 'none', destination: join(dir, 'archive') },
    });

    const results = await archiver.archiveAll();
    expect(results.map((r) => r.source)).toEqual(['a.log']);
  });

  it('rejects duplicate source names', () => {
    expect(() =>
      createArchiver({ sources: [{ path: '/tmp/a.log' }, { path: '/tmp/a.log' }] }),
    ).toThrow(ArchiverConfigError);
  });

  it('rejects a source with no path', () => {
    expect(() => createArchiver({ sources: [{ path: '' }] })).toThrow(ArchiverConfigError);
  });

  it('stops the loop on scope exit', async () => {
    const dir = await tempDir();
    const archiver = createArchiver({ sources: [{ path: join(dir, 'a.log') }] }).start();
    await archiver[Symbol.asyncDispose]();
    expect(archiver.running).toBe(false);
  });
});
