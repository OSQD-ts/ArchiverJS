/** Public types shared across the library. */

import type { Duplex, Readable } from 'node:stream';
import type { DurationInput, SizeInput } from './units.js';

/* -------------------------------------------------------------------------- */
/* Triggers                                                                    */
/* -------------------------------------------------------------------------- */

/** What a trigger knows about a source when it is asked to decide. */
export interface TriggerContext {
  /** Absolute path of the source file. */
  readonly path: string;
  /** Size in bytes, and the timestamps — `null` when the file does not exist. */
  readonly stats: SourceStats | null;
  /** Current time in ms since the epoch (injectable, so tests need no sleeping). */
  readonly now: number;
  /** When this source was last archived by this process, or `null` if never. */
  readonly lastArchivedAt: number | null;
}

/** The subset of `fs.Stats` archival decisions actually depend on. */
export interface SourceStats {
  readonly size: number;
  readonly birthtimeMs: number;
  readonly mtimeMs: number;
}

/**
 * A rule that decides whether a source should be archived right now.
 *
 * Triggers are pure predicates over {@link TriggerContext}: they never touch
 * the filesystem themselves, which is what makes them trivially testable and
 * cheap to evaluate on every tick.
 */
export interface Trigger {
  /** Short identifier, reported on the `archived` event as the reason. */
  readonly name: string;
  /** `true` when the source should be archived. */
  test(context: TriggerContext): boolean;
  /**
   * Optional hint: the earliest timestamp at which this trigger could become
   * true, or `null` when it cannot say (a size limit depends on how fast the
   * file grows, so `size()` never answers). Surfaced through
   * `Source.nextDueAt()` for monitoring — "when does this log next roll?" —
   * rather than used to skip checks, because a trigger that guessed wrong would
   * then silently stop rotating.
   */
  readonly dueAt?: (context: TriggerContext) => number | null;
}

/* -------------------------------------------------------------------------- */
/* Compression                                                                 */
/* -------------------------------------------------------------------------- */

/** Built-in compression methods. `zstd` requires Node >= 22.15. */
export type CompressionMethod = 'none' | 'gzip' | 'deflate' | 'brotli' | 'zstd';

/** A compression method plus tuning. */
export interface CompressionOptions {
  method: CompressionMethod;
  /** Codec-specific level. Higher is smaller and slower; defaults to the codec's own default. */
  level?: number;
}

/** Anything accepted where a codec is expected. */
export type CompressionInput = CompressionMethod | CompressionOptions | Codec;

/** A compression algorithm: a stream factory plus the suffix it adds to filenames. */
export interface Codec {
  readonly name: string;
  /** Suffix appended to the archive filename, including the dot (`''` for no-op codecs). */
  readonly extension: string;
  /** Build a fresh transform stream, or `null` to store the bytes verbatim. Called once per archive. */
  createCompressor(): Duplex | null;
}

/* -------------------------------------------------------------------------- */
/* Stores                                                                      */
/* -------------------------------------------------------------------------- */

/** Metadata handed to a store alongside the archive body. */
export interface ArchiveMetadata {
  /** Absolute path of the file being archived. */
  readonly sourcePath: string;
  /** Size of the source before compression, in bytes. */
  readonly sourceBytes: number;
  /** When the archival run started (ms since the epoch). */
  readonly archivedAt: number;
  /** Name of the codec used. */
  readonly compression: string;
  /**
   * Permission bits of the source file.
   *
   * A store that persists to a filesystem should apply these to the archive: a
   * log kept at `0600` because of what is in it must not become a world-readable
   * `0644` archive sitting next to it.
   */
  readonly sourceMode: number;
}

/** An archive that has been persisted. */
export interface StoredArchive {
  /** Key within the store — for the local store, the filename. */
  readonly key: string;
  /** Human-facing location: an absolute path, a URL, whatever the store uses. */
  readonly location: string;
  /** Size of the stored (compressed) archive in bytes. */
  readonly bytes: number;
  /** Creation time in ms since the epoch. */
  readonly createdAt: number;
}

/**
 * Where finished archives go.
 *
 * The library ships a local-filesystem store; implement this interface to send
 * archives somewhere else (object storage, a share, a test double) without the
 * core needing to know anything about it.
 */
export interface ArchiveStore {
  readonly name: string;
  /** Persist `body` under `key`. Must consume the stream fully before resolving. */
  put(key: string, body: Readable, metadata: ArchiveMetadata): Promise<StoredArchive>;
  /** Every archive previously written under `prefix`, in any order. */
  list(prefix: string): Promise<StoredArchive[]>;
  /** Delete one archive. */
  remove(archive: StoredArchive): Promise<void>;
  /** `true` if `key` is already taken — used to avoid clobbering. */
  has(key: string): Promise<boolean>;
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How much history to keep. Every limit that is set is applied; the oldest
 * archives are removed first, and an archive surviving one limit can still be
 * removed by another.
 */
export interface RetentionPolicy {
  /** Keep at most this many archives per source. */
  maxFiles?: number;
  /** Delete archives older than this. */
  maxAge?: DurationInput;
  /** Keep the archives for a source under this combined size. */
  maxTotalSize?: SizeInput;
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                      */
/* -------------------------------------------------------------------------- */

/** Values available to a filename template. */
export interface NameContext {
  /** Source basename without its extension — `app` for `app.log`. */
  readonly name: string;
  /** Source extension including the dot — `.log` for `app.log` (`''` if none). */
  readonly ext: string;
  /** Rotation timestamp. */
  readonly date: Date;
  /** Sequence number, starting at 1, of archives already kept for this source. */
  readonly index: number;
  /** Suffix contributed by the codec, e.g. `.gz`. */
  readonly compressExt: string;
}

/** A filename template string, or a function that builds the name itself. */
export type NameTemplate = string | ((context: NameContext) => string);

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How a running program's file is detached from the writer.
 *
 * - `rename` moves the file aside and creates a fresh one in its place. It is
 *   atomic and loses nothing, but a foreign writer holding an open descriptor
 *   keeps writing into the moved-away inode until it reopens. Use it when the
 *   writer is this library, or a logger that reopens on `SIGHUP`.
 * - `copy-truncate` copies the contents out and truncates the file in place, so
 *   an open descriptor keeps working untouched. This is what you want for a
 *   process you do not control. See the README for its (small) race window.
 */
export type ArchiveStrategy = 'rename' | 'copy-truncate';

/** What the {@link SourceConfig.onDetached} hook is told. */
export interface DetachedInfo {
  /** Source name. */
  readonly source: string;
  /** The source path as configured — already empty, or already replaced. */
  readonly path: string;
  /** Where the detached contents are, on their way to the store. */
  readonly detachedPath: string;
  /** How many bytes came out. */
  readonly bytes: number;
  /** Which strategy separated them. */
  readonly strategy: ArchiveStrategy;
}

/** One file watched for archival. */
export interface SourceConfig {
  /** Path to the file. It need not exist yet. */
  path: string;
  /** Identifier used in events and errors. Defaults to the file's basename. */
  name?: string;
  /**
   * Rules that trigger archival. An array fires when *any* rule matches.
   * Defaults to `size('10mb')`.
   */
  when?: Trigger | Trigger[];
  /** Directory for archives. Defaults to the source's own directory. */
  destination?: string;
  /** Send archives somewhere other than the local filesystem. Overrides `destination`. */
  store?: ArchiveStore;
  /** Compression to apply. Defaults to `'gzip'`. */
  compress?: CompressionInput;
  /** How to detach the file from its writer. Defaults to `'rename'`. */
  strategy?: ArchiveStrategy;
  /** Archive filename. Defaults to `'{name}-{timestamp}{ext}{compressExt}'`. */
  filename?: NameTemplate;
  /** How much history to keep. Defaults to `{ maxFiles: 10 }`. */
  retention?: RetentionPolicy | false;
  /** Never archive a file smaller than this. Defaults to `1` byte, i.e. skip empty files. */
  minSize?: SizeInput;
  /**
   * Take a lock file next to the source for the duration of a run, so a second
   * archiver — another replica, a stray cron job — cannot rotate it at the same
   * time. Defaults to `true`. Turn it off only where the source directory is
   * read-only or the lock file itself would be picked up by something else.
   */
  lock?: boolean;
  /**
   * Called the moment the contents leave the live file, before any compression
   * or upload begins, and awaited before either starts.
   *
   * This is where you tell the writer to reopen. Under `rename`, a process
   * still holding the old descriptor writes into the file we are about to
   * archive and delete, so the sooner it reopens the less it can lose — and
   * "the sooner" means here, not from the `archived` event, which does not fire
   * until the archive has been compressed and stored.
   *
   * ```ts
   * onDetached: () => process.kill(nginxPid, 'SIGHUP'),
   * ```
   *
   * A hook that throws does not fail the archival — the bytes are already out
   * and storing them is what matters — but the failure is reported through
   * {@link SourceConfig.onWarning}.
   */
  onDetached?: (info: DetachedInfo) => void | Promise<void>;
  /**
   * Called for problems that did not stop the archive from being stored: a
   * hook that threw, or retention failing to delete an old file. The archiver
   * re-emits these as `warning`, and the rotating stream as `warning` too.
   */
  onWarning?: (error: Error) => void;
}

/* -------------------------------------------------------------------------- */
/* Results and events                                                          */
/* -------------------------------------------------------------------------- */

/** The outcome of one completed archival run. */
export interface ArchiveResult {
  /** Source name. */
  readonly source: string;
  /** Absolute path of the source. */
  readonly path: string;
  /** Where the archive ended up. */
  readonly archive: StoredArchive;
  /** Bytes read from the source. */
  readonly sourceBytes: number;
  /** Bytes written to the store. */
  readonly archiveBytes: number;
  /** Codec used. */
  readonly compression: string;
  /** Name of the trigger that fired, or `'manual'` for an explicit call. */
  readonly reason: string;
  /** Wall-clock duration of the run in ms. */
  readonly durationMs: number;
  /** Archives deleted by the retention policy during this run. */
  readonly pruned: readonly StoredArchive[];
}

/** Why a check decided not to archive. */
export type SkipReason = 'missing' | 'too-small' | 'no-trigger' | 'busy' | 'locked';

/** Events emitted by {@link ArchiverInstance} and rotating streams. */
export interface ArchiverEvents {
  /** A file was archived. */
  archived: (result: ArchiveResult) => void;
  /** A check ran and decided to do nothing. */
  skipped: (info: { source: string; path: string; reason: SkipReason }) => void;
  /** Retention removed archives. */
  pruned: (info: { source: string; removed: readonly StoredArchive[] }) => void;
  /** An archival run failed. The archiver keeps running. */
  error: (error: Error) => void;
  /**
   * Something went wrong that did not stop the archive from being stored — a
   * hook that threw, or a retention delete that failed. Worth logging, not
   * worth paging anyone.
   */
  warning: (error: Error) => void;
}
