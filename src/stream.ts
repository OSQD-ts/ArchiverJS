/**
 * A writable stream that rotates itself.
 *
 * This is the seamless case: the program writes log lines, the stream decides
 * when the file has grown or aged enough, and archival happens between two
 * writes. Because the stream owns the file descriptor it can close, rename and
 * reopen atomically — no copy-truncate race, no cooperation from anyone else.
 */

import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Writable } from 'node:stream';
import { ensureDir } from './internal/fs.js';
import { Source } from './source.js';
import type { ArchiveResult, SourceConfig, SourceStats, StoredArchive } from './types.js';
import { parseDuration, type DurationInput } from './units.js';

/** Events a {@link RotatingFileStream} adds to the usual `Writable` ones. */
export interface RotatingFileStreamEvents {
  /** A rotation completed. */
  archived: (result: ArchiveResult) => void;
  /** Retention removed old archives. */
  pruned: (info: { source: string; removed: readonly StoredArchive[] }) => void;
  /**
   * A rotation failed. Reported separately from `'error'` on purpose: a failed
   * archive must not take down an application's logging, and an unhandled
   * `'error'` on a stream throws.
   */
  'archive-error': (error: Error) => void;
  /**
   * Something went wrong that did not stop the rotation — a hook that threw, or
   * retention failing to delete an old archive.
   */
  warning: (error: Error) => void;
}

export interface RotatingFileStreamOptions extends Omit<SourceConfig, 'strategy'> {
  /** Encoding for string writes. Defaults to `'utf8'`. */
  encoding?: BufferEncoding;
  /** Mode for the log file when it is created. Defaults to `0o644`. */
  mode?: number;
  /**
   * How often to re-evaluate time-based triggers on an idle stream. Defaults to
   * `'30s'`; pass `0` to only ever check on write.
   */
  checkInterval?: DurationInput;
  /** Let the idle-check timer keep the process alive. Defaults to `false`. */
  keepAlive?: boolean;
}

/**
 * A `Writable` that archives its own output. Create one with
 * {@link createRotatingStream}.
 */
export class RotatingFileStream extends Writable {
  readonly source: Source;

  readonly #mode: number;
  readonly #checkInterval: number;
  readonly #keepAlive: boolean;
  #handle: FileHandle | null = null;
  #size = 0;
  #openedAt = Date.now();
  #timer: NodeJS.Timeout | null = null;
  /** Serializes writes against timer-driven rotations. */
  #busy: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: RotatingFileStreamOptions) {
    super({ decodeStrings: true, defaultEncoding: options.encoding ?? 'utf8' });
    // Rotation always renames: the stream closes its own descriptor first, so
    // the atomic path is available and nothing can be lost.
    this.source = new Source({
      ...options,
      strategy: 'rename',
      onWarning: options.onWarning ?? ((error) => this.emit('warning', error)),
    });
    this.#mode = options.mode ?? 0o644;
    this.#checkInterval = parseDuration(options.checkInterval ?? '30s', 'checkInterval');
    this.#keepAlive = options.keepAlive ?? false;
    if (this.#checkInterval > 0) this.#startTimer();
  }

  /** Path of the live file. */
  get path(): string {
    return this.source.path;
  }

  /** Bytes currently in the live file. Tracked in memory, so this costs nothing. */
  get size(): number {
    return this.#size;
  }

  /** Rotate right now, whatever the triggers say. Resolves once the archive is stored. */
  async rotate(reason = 'manual'): Promise<ArchiveResult | null> {
    let result: ArchiveResult | null = null;
    await this.#serialize(async () => {
      result = await this.#rotate(reason);
    });
    return result;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#serialize(() => this.#append([chunk])).then(
      () => callback(),
      (error: unknown) => callback(error as Error),
    );
  }

  override _writev(
    chunks: Array<{ chunk: Buffer }>,
    callback: (error?: Error | null) => void,
  ): void {
    this.#serialize(() => this.#append(chunks.map((entry) => entry.chunk))).then(
      () => callback(),
      (error: unknown) => callback(error as Error),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#closed = true;
    this.#stopTimer();
    this.#serialize(async () => {
      await this.#handle?.close();
      this.#handle = null;
    }).then(
      () => callback(),
      (error: unknown) => callback(error as Error),
    );
  }

  override on<E extends keyof RotatingFileStreamEvents>(
    event: E,
    listener: RotatingFileStreamEvents[E],
  ): this;
  override on(event: string | symbol, listener: (...args: never[]) => void): this;
  override on(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  /**
   * Append `chunks`, rotating before any chunk that would push the file past a
   * trigger, so the live file never exceeds the size the user asked for.
   *
   * Backpressure hands us whole batches at a time, and those must still be
   * split at the rotation boundary — otherwise a busy moment silently produces
   * one oversized segment. Everything between two boundaries is written as a
   * single `appendFile`, so the common case is still one syscall per batch.
   */
  async #append(chunks: readonly Buffer[]): Promise<void> {
    let handle = await this.#ensureOpen();
    let batch: Buffer[] = [];
    let batched = 0;

    const flush = async (): Promise<void> => {
      if (batched === 0) return;
      await handle.appendFile(batch.length === 1 ? batch[0]! : Buffer.concat(batch));
      this.#size += batched;
      batch = [];
      batched = 0;
    };

    for (const chunk of chunks) {
      const live = this.#size + batched;
      const projected: SourceStats = {
        size: live + chunk.byteLength,
        birthtimeMs: this.#openedAt,
        mtimeMs: Date.now(),
      };
      // An empty live file is never worth rotating: doing so would archive
      // nothing and leave the oversized chunk in the fresh file anyway.
      const fired = live > 0 ? this.source.shouldArchive(projected) : null;
      if (fired) {
        await flush();
        await this.#rotate(fired.name);
        handle = await this.#ensureOpen();
      }
      batch.push(chunk);
      batched += chunk.byteLength;
    }

    await flush();
  }

  async #ensureOpen(): Promise<FileHandle> {
    if (this.#handle) return this.#handle;
    // Recover the rotation cadence from the archives already in the store, so a
    // restart does not re-arm `daily()` from zero.
    await this.source.prime();
    await ensureDir(dirname(this.source.path));
    const handle = await open(this.source.path, 'a', this.#mode);
    const stats = await handle.stat();
    // Appending to an existing log continues it; its size counts towards the
    // very next rotation decision.
    this.#size = stats.size;
    this.#openedAt = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
    this.#handle = handle;
    return handle;
  }

  /** Close, hand the file to the archiver, reopen. Callers must hold {@link #serialize}. */
  async #rotate(reason: string): Promise<ArchiveResult | null> {
    await this.#handle?.close();
    this.#handle = null;
    this.#size = 0;
    try {
      const result = await this.source.archive(reason);
      this.emit('archived', result);
      if (result.pruned.length > 0) {
        this.emit('pruned', { source: result.source, removed: result.pruned });
      }
      return result;
    } catch (error) {
      this.emit('archive-error', error instanceof Error ? error : new Error(String(error)));
      return null;
    } finally {
      this.#openedAt = Date.now();
      if (!this.#closed) await this.#ensureOpen();
    }
  }

  /** Run `task` after everything already queued, and never let the chain reject. */
  #serialize(task: () => Promise<void | ArchiveResult | null>): Promise<void> {
    const run = this.#busy.then(task);
    this.#busy = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() => undefined);
  }

  #startTimer(): void {
    this.#timer = setInterval(() => {
      void this.#serialize(async () => {
        if (this.#closed || this.#size === 0) return;
        const fired = this.source.shouldArchive(
          { size: this.#size, birthtimeMs: this.#openedAt, mtimeMs: Date.now() },
          Date.now(),
        );
        if (fired) await this.#rotate(fired.name);
      });
    }, this.#checkInterval);
    if (!this.#keepAlive) this.#timer.unref();
  }

  #stopTimer(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}

/**
 * Open a self-archiving log file.
 *
 * ```ts
 * const log = createRotatingStream({
 *   path: 'logs/app.log',
 *   when: [size('10mb'), daily()],
 *   compress: 'gzip',
 *   retention: { maxFiles: 14 },
 * });
 * log.write(`${new Date().toISOString()} started\n`);
 * ```
 */
export function createRotatingStream(options: RotatingFileStreamOptions): RotatingFileStream {
  return new RotatingFileStream(options);
}
