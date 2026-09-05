import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createRotatingStream, type RotatingFileStream } from '../src/stream.js';
import { age, size } from '../src/triggers.js';
import type { ArchiveResult } from '../src/types.js';
import { tempDir } from './helpers.js';

/** Write and wait for the stream to have accepted the chunk. */
function write(stream: RotatingFileStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function close(stream: RotatingFileStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end(() => resolve());
    stream.once('error', reject);
  });
}

describe('RotatingFileStream', () => {
  it('rotates before a write that would exceed the size limit', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const stream = createRotatingStream({
      path,
      when: size(20),
      compress: 'none',
      destination: join(dir, 'archive'),
      filename: '{name}.{index}{ext}',
      checkInterval: 0,
    });

    const archived: ArchiveResult[] = [];
    stream.on('archived', (result) => archived.push(result));

    for (let i = 0; i < 5; i += 1) await write(stream, `line ${i}\n`);
    await close(stream);

    // 7 bytes a line against a 20-byte limit: the third line would overflow, so
    // the two before it are archived first and the live file never exceeds 20.
    expect(archived).toHaveLength(2);
    expect(await readFile(archived[0]!.archive.location, 'utf8')).toBe('line 0\nline 1\n');
    expect(await readFile(archived[1]!.archive.location, 'utf8')).toBe('line 2\nline 3\n');
    expect(await readFile(path, 'utf8')).toBe('line 4\n');
  });

  it('never lets the live file grow past the limit', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const stream = createRotatingStream({
      path,
      when: size(100),
      compress: 'none',
      destination: join(dir, 'archive'),
      filename: '{name}.{index}{ext}',
      retention: false,
      checkInterval: 0,
    });

    let peak = 0;
    for (let i = 0; i < 60; i += 1) {
      await write(stream, `${'x'.repeat(19)}\n`);
      peak = Math.max(peak, stream.size);
    }
    await close(stream);

    expect(peak).toBeLessThanOrEqual(100);
    // 20-byte lines, 100-byte limit: four lines per segment, 60 lines in.
    expect(await readdir(join(dir, 'archive'))).toHaveLength(14);
  });

  it('compresses rotated segments and applies retention', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const stream = createRotatingStream({
      path,
      when: size(50),
      compress: 'gzip',
      destination: join(dir, 'archive'),
      filename: '{name}.{index}{ext}{compressExt}',
      retention: { maxFiles: 2 },
      checkInterval: 0,
    });

    for (let i = 0; i < 30; i += 1) await write(stream, `entry ${i}\n`);
    await close(stream);

    const archives = (await readdir(join(dir, 'archive'))).sort();
    expect(archives).toHaveLength(2);
    expect(gunzipSync(await readFile(join(dir, 'archive', archives[0]!))).toString()).toContain(
      'entry ',
    );
  });

  it('continues an existing log file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'earlier\n');

    const stream = createRotatingStream({ path, when: size('1gb'), checkInterval: 0 });
    await write(stream, 'later\n');
    await close(stream);

    expect(stream.size).toBe('earlier\n'.length + 'later\n'.length);
    expect(await readFile(path, 'utf8')).toBe('earlier\nlater\n');
  });

  it('rotates an idle stream when a time-based trigger comes due', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const stream = createRotatingStream({
      path,
      when: age('30ms'),
      compress: 'none',
      destination: join(dir, 'archive'),
      checkInterval: '10ms',
    });

    const archived: ArchiveResult[] = [];
    stream.on('archived', (result) => archived.push(result));

    await write(stream, 'idle from here on\n');
    // No further writes: only the idle timer can notice the file has aged.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await close(stream);

    expect(archived).toHaveLength(1);
    expect(archived[0]?.reason).toBe(age('30ms').name);
    expect(await readFile(archived[0]!.archive.location, 'utf8')).toBe('idle from here on\n');
  });

  it('rotates on demand', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const stream = createRotatingStream({
      path,
      when: size('1gb'),
      compress: 'none',
      destination: join(dir, 'archive'),
      checkInterval: 0,
    });

    await write(stream, 'before\n');
    const result = await stream.rotate();
    await write(stream, 'after\n');
    await close(stream);

    expect(result?.reason).toBe('manual');
    expect(await readFile(result!.archive.location, 'utf8')).toBe('before\n');
    expect(await readFile(path, 'utf8')).toBe('after\n');
    expect(stream.size).toBe('after\n'.length);
  });

  it('keeps logging when archival fails, reporting on archive-error', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const stream = createRotatingStream({
      path,
      when: size(10),
      checkInterval: 0,
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

    const failures: Error[] = [];
    stream.on('archive-error', (error) => failures.push(error));

    await write(stream, 'first line\n');
    await write(stream, 'second line\n');
    await close(stream);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('store is down');
    // Nothing was lost: the failed rotation put the bytes back.
    expect(await readFile(path, 'utf8')).toBe('first line\nsecond line\n');
  });

  it('splits a batched write at the rotation boundary', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const stream = createRotatingStream({
      path,
      when: size(100),
      compress: 'none',
      destination: join(dir, 'archive'),
      filename: '{name}.{index}{ext}',
      retention: false,
      checkInterval: 0,
    });

    // No awaiting: every line after the first is buffered and delivered to the
    // stream as one `_writev` batch, which must still rotate line by line.
    for (let i = 0; i < 100; i += 1) stream.write(`${'x'.repeat(19)}\n`);
    await close(stream);

    const archiveDir = join(dir, 'archive');
    const sizes = await Promise.all(
      (await readdir(archiveDir)).map(async (file) =>
        (await readFile(join(archiveDir, file))).byteLength,
      ),
    );
    expect(sizes).not.toHaveLength(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
  });

  it('survives many interleaved writes without dropping bytes', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    const stream = createRotatingStream({
      path,
      when: size(64),
      compress: 'none',
      destination: join(dir, 'archive'),
      filename: '{name}.{index}{ext}',
      retention: false,
      checkInterval: 0,
    });

    const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(4, '0')}\n`);
    // Fire them all at once: the stream must serialize writes against rotations.
    await Promise.all(lines.map((line) => write(stream, line)));
    await close(stream);

    const archiveDir = join(dir, 'archive');
    const parts = await Promise.all(
      (await readdir(archiveDir))
        .sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
        .map((file) => readFile(join(archiveDir, file), 'utf8')),
    );
    const everything = parts.join('') + (await readFile(path, 'utf8'));
    expect(everything).toBe(lines.join(''));
  });
});
