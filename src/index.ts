/**
 * archiverjs — seamless automatic archival for TypeScript and Node.js.
 *
 * Two ways in, depending on who owns the file:
 *
 * ```ts
 * // 1. The program writes the log itself — let the stream rotate itself.
 * import { createRotatingStream, size, daily } from '@osqd/archiverjs';
 *
 * const log = createRotatingStream({
 *   path: 'logs/app.log',
 *   when: [size('10mb'), daily('00:00')],
 *   compress: 'gzip',
 *   retention: { maxFiles: 14, maxAge: '30d' },
 * });
 * log.write('server started\n');
 * ```
 *
 * ```ts
 * // 2. Something else writes the file — watch it and archive underneath.
 * import { createArchiver, size, age } from '@osqd/archiverjs';
 *
 * const archiver = createArchiver({
 *   sources: [{ path: '/var/log/app.log', when: [size('100mb'), age('1d')] }],
 *   defaults: { compress: 'zstd', strategy: 'copy-truncate' },
 * }).start();
 * ```
 */

export { Archiver, archiveFile, createArchiver } from './archiver.js';
export type { ArchiverOptions, SourceDefaults } from './archiver.js';

export { Source } from './source.js';
export type { ArchivedOutcome, CheckOutcome, SkipOutcome } from './source.js';

export { RotatingFileStream, createRotatingStream } from './stream.js';
export type { RotatingFileStreamEvents, RotatingFileStreamOptions } from './stream.js';

export { all, age, any, daily, earliest, every, firstMatch, size, when } from './triggers.js';

export { LocalFileStore } from './store.js';
export type { LocalFileStoreOptions } from './store.js';

export { isCompressionAvailable, noCompression, resolveCodec } from './compression.js';

export { DEFAULT_RETENTION, selectForRemoval } from './retention.js';
export type { ResolvedRetention } from './retention.js';

export { DEFAULT_TEMPLATE, renderName } from './template.js';

export { formatBytes, parseDuration, parseSize } from './units.js';
export type { DurationInput, SizeInput } from './units.js';

export {
  ArchiveFailedError,
  ArchiverConfigError,
  ArchiverError,
  CompressionUnavailableError,
  SourceLockedError,
} from './errors.js';

export type {
  ArchiveMetadata,
  ArchiveResult,
  ArchiveStore,
  ArchiveStrategy,
  ArchiverEvents,
  Codec,
  CompressionInput,
  CompressionMethod,
  CompressionOptions,
  DetachedInfo,
  NameContext,
  NameTemplate,
  RetentionPolicy,
  SkipReason,
  SourceConfig,
  SourceStats,
  StoredArchive,
  Trigger,
  TriggerContext,
} from './types.js';
