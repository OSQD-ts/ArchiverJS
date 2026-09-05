import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { archiveFile } from '../src/archiver.js';
import { isCompressionAvailable, noCompression, resolveCodec } from '../src/compression.js';
import { CompressionUnavailableError } from '../src/errors.js';
import type { Codec } from '../src/types.js';
import { tempDir } from './helpers.js';

describe('resolveCodec', () => {
  it('defaults to gzip', () => {
    expect(resolveCodec(undefined).name).toBe('gzip');
  });

  it('accepts a name, an options object, or a codec', () => {
    expect(resolveCodec('brotli').extension).toBe('.br');
    expect(resolveCodec({ method: 'gzip', level: 9 }).name).toBe('gzip');
    expect(resolveCodec(noCompression)).toBe(noCompression);
  });

  it('rejects an unknown method', () => {
    expect(() => resolveCodec('lzma' as 'gzip')).toThrow(CompressionUnavailableError);
  });
});

describe('zstd', () => {
  it.skipIf(!isCompressionAvailable('zstd'))('round-trips when the runtime supports it', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'zstd me\n'.repeat(100));

    const result = await archiveFile(path, { compress: 'zstd' });

    expect(result.archive.key.endsWith('.zst')).toBe(true);
    expect(result.archiveBytes).toBeLessThan(result.sourceBytes);
  });
});

describe('a custom codec', () => {
  it('is used for both the bytes and the filename suffix', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'abc');

    const upper: Codec = {
      name: 'shout',
      extension: '.loud',
      createCompressor() {
        return new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            callback(null, Buffer.from(chunk.toString().toUpperCase()));
          },
        });
      },
    };

    const result = await archiveFile(path, { compress: upper });

    expect(result.compression).toBe('shout');
    expect(result.archive.key.endsWith('.log.loud')).toBe(true);
    expect(await readFile(result.archive.location, 'utf8')).toBe('ABC');
  });
});
