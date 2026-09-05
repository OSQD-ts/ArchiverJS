/**
 * Codecs.
 *
 * All of them come from `node:zlib` — the library has no runtime dependencies,
 * and compression happens as a stream so a multi-gigabyte log never has to be
 * held in memory.
 */

import type { Duplex } from 'node:stream';
import * as zlib from 'node:zlib';
import { CompressionUnavailableError } from './errors.js';
import type { Codec, CompressionInput, CompressionMethod, CompressionOptions } from './types.js';

/**
 * zstd landed in `node:zlib` after this package's `@types/node` floor, so it is
 * reached through a narrow structural view rather than the published types.
 */
const zstdExtras = zlib as unknown as {
  createZstdCompress?: (options?: unknown) => Duplex;
};

/** Codec that passes bytes through untouched. */
export const noCompression: Codec = {
  name: 'none',
  extension: '',
  createCompressor: () => null,
};

function gzip(level?: number): Codec {
  return {
    name: 'gzip',
    extension: '.gz',
    createCompressor: () => zlib.createGzip(level === undefined ? undefined : { level }),
  };
}

function deflate(level?: number): Codec {
  return {
    name: 'deflate',
    extension: '.zz',
    createCompressor: () => zlib.createDeflate(level === undefined ? undefined : { level }),
  };
}

function brotli(level?: number): Codec {
  return {
    name: 'brotli',
    extension: '.br',
    createCompressor: () =>
      zlib.createBrotliCompress(
        level === undefined
          ? undefined
          : { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level } },
      ),
  };
}

function zstd(level?: number): Codec {
  return {
    name: 'zstd',
    extension: '.zst',
    createCompressor: () => {
      // Added in Node 22.15 / 23.8; resolved lazily so merely importing the
      // library stays safe on older runtimes.
      const create = zstdExtras.createZstdCompress;
      if (typeof create !== 'function') throw new CompressionUnavailableError('zstd');
      if (level === undefined) return create();
      const levelParam = (zlib.constants as unknown as Record<string, number>)['ZSTD_c_compressionLevel'];
      return create(levelParam === undefined ? undefined : { params: { [levelParam]: level } });
    },
  };
}

const FACTORIES: Record<CompressionMethod, (level?: number) => Codec> = {
  none: () => noCompression,
  gzip,
  deflate,
  brotli,
  zstd,
};

/** `true` if this Node build can run the given method. */
export function isCompressionAvailable(method: CompressionMethod): boolean {
  if (method !== 'zstd') return true;
  return typeof zstdExtras.createZstdCompress === 'function';
}

function isCodec(value: CompressionInput): value is Codec {
  return typeof value === 'object' && value !== null && 'createCompressor' in value;
}

/** Normalize whatever the user passed for `compress` into a {@link Codec}. */
export function resolveCodec(input: CompressionInput | undefined): Codec {
  if (input === undefined) return FACTORIES.gzip();
  if (isCodec(input)) return input;
  const { method, level } =
    typeof input === 'string' ? ({ method: input } as CompressionOptions) : input;
  const factory = FACTORIES[method];
  if (!factory) {
    throw new CompressionUnavailableError(String(method));
  }
  return factory(level);
}
