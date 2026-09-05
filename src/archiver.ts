/**
 * The archiver: a small scheduler that keeps a set of {@link Source}s in check.
 *
 * It is intentionally a poller rather than an `fs.watch` consumer. Watching
 * gives no signal for "this file is now a day old", fires storms of events for
 * a busy log, and behaves differently on every platform and network mount. A
 * `stat` every thirty seconds is cheaper than any of that.
 */

import { TypedEmitter } from './internal/emitter.js';
import { statOrNull } from './internal/fs.js';
import { Source, type CheckOutcome } from './source.js';
import type { ArchiveResult, ArchiverEvents, SourceConfig } from './types.js';
import { parseDuration, type DurationInput } from './units.js';
import { ArchiveFailedError, ArchiverConfigError, SourceLockedError } from './errors.js';

/** Options shared by every source of an archiver. */
export type SourceDefaults = Omit<SourceConfig, 'path' | 'name'>;

export interface ArchiverOptions {
  /** The files to keep an eye on. */
  sources: SourceConfig | SourceConfig[];
  /** How often to evaluate the triggers. Defaults to `'30s'`. */
  checkInterval?: DurationInput;
  /** Settings applied to every source unless the source overrides them. */
  defaults?: SourceDefaults;
  /**
   * Keep the Node event loop alive while the archiver runs. Defaults to
   * `false`, so background archival never stops a program from exiting.
   */
  keepAlive?: boolean;
  /** Called for every failure. Equivalent to subscribing to the `error` event. */
  onError?: (error: Error) => void;
}

/**
 * Watches files and archives them when their triggers fire.
 *
 * Create one with {@link createArchiver}.
 */
export class Archiver extends TypedEmitter<ArchiverEvents> {
  readonly #sources = new Map<string, Source>();
  readonly #interval: number;
  readonly #defaults: SourceDefaults;
  readonly #keepAlive: boolean;
  #timer: NodeJS.Timeout | null = null;
  #tick: Promise<CheckOutcome[]> | null = null;

  constructor(options: ArchiverOptions) {
    // A listener that throws is the listener's problem; surface it on `error`
    // rather than letting it unwind the scheduler.
    super((error) => queueMicrotask(() => this.emit('error', asError(error))));
    this.#interval = parseDuration(options.checkInterval ?? '30s', 'checkInterval');
    if (this.#interval < 1) throw new ArchiverConfigError('checkInterval must be at least 1ms');
    this.#defaults = options.defaults ?? {};
    this.#keepAlive = options.keepAlive ?? false;
    if (options.onError) this.on('error', options.onError);

    const configs = Array.isArray(options.sources) ? options.sources : [options.sources];
    if (configs.length === 0) throw new ArchiverConfigError('at least one source is required');
    for (const config of configs) this.add(config);
  }

  /** Every configured source, in insertion order. */
  get sources(): readonly Source[] {
    return [...this.#sources.values()];
  }

  /** `true` between {@link start} and {@link stop}. */
  get running(): boolean {
    return this.#timer !== null;
  }

  /** Register another source while running. */
  add(config: SourceConfig): Source {
    const merged = { ...this.#defaults, ...config };
    const source = new Source({
      ...merged,
      // Non-fatal problems inside a source reach the outside world through the
      // archiver's own events, unless the source was given its own handler.
      onWarning: merged.onWarning ?? ((error) => this.emit('warning', error)),
    });
    if (this.#sources.has(source.name)) {
      throw new ArchiverConfigError(
        `duplicate source name '${source.name}' — give one of them an explicit 'name'`,
      );
    }
    this.#sources.set(source.name, source);
    return source;
  }

  /** Stop watching a source. Returns `false` if there was no such source. */
  remove(name: string): boolean {
    return this.#sources.delete(name);
  }

  /** Look a source up by name. */
  get(name: string): Source | undefined {
    return this.#sources.get(name);
  }

  /**
   * When each source is next expected to roll, for whatever can say.
   *
   * A monitoring endpoint's answer to "is archival actually working?" — a
   * source whose due time is in the past has been failing to rotate.
   */
  async schedule(now = Date.now()): Promise<Array<{ source: string; dueAt: number | null }>> {
    return Promise.all(
      this.sources.map(async (source) => ({
        source: source.name,
        dueAt: await source.nextDueAt(now),
      })),
    );
  }

  /** Begin the check loop. Idempotent. */
  start(): this {
    if (this.#timer) return this;
    // Skip a tick outright when the previous pass is still running: a slow
    // store must not build a queue of passes that all fire at once later.
    this.#timer = setInterval(() => {
      if (this.#tick === null) void this.check().catch(() => undefined);
    }, this.#interval);
    if (!this.#keepAlive) this.#timer.unref();
    return this;
  }

  /** Stop the check loop and wait for any run already in flight. */
  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#tick?.catch(() => undefined);
  }

  /**
   * Run one check pass immediately.
   *
   * Sources are checked one at a time: archival is IO-bound and a burst of
   * parallel compression is exactly the kind of hiccup a background utility
   * should not cause. An explicit call made while a pass is running queues
   * behind it rather than quietly returning the other pass's results — the
   * caller asked about *now*, not about whenever the timer last looked.
   */
  check(now = Date.now()): Promise<CheckOutcome[]> {
    const previous = this.#tick ?? Promise.resolve([]);
    const run = previous.then(
      () => this.#checkAll(now),
      () => this.#checkAll(now),
    );
    this.#tick = run;
    void run.then(
      () => {
        if (this.#tick === run) this.#tick = null;
      },
      () => {
        if (this.#tick === run) this.#tick = null;
      },
    );
    return run;
  }

  /** Archive one source now, ignoring its triggers. */
  async archive(name: string): Promise<ArchiveResult> {
    const source = this.#sources.get(name);
    if (!source) throw new ArchiverConfigError(`no such source: '${name}'`);
    const result = await source.archive('manual');
    this.#report({ archived: true, result });
    return result;
  }

  /** Archive every source now, ignoring triggers. Sources with nothing to archive are skipped. */
  async archiveAll(): Promise<ArchiveResult[]> {
    const results: ArchiveResult[] = [];
    for (const source of this.#sources.values()) {
      const stats = await statOrNull(source.path);
      if (!stats || stats.size < source.minSize) continue;
      try {
        const result = await source.archive('manual');
        this.#report({ archived: true, result });
        results.push(result);
      } catch (error) {
        // A source another process is rotating is skipped, not an error.
        if (error instanceof ArchiveFailedError && error.cause instanceof SourceLockedError) {
          this.emit('skipped', { source: source.name, path: source.path, reason: 'locked' });
        } else {
          this.emit('error', asError(error));
        }
      }
    }
    return results;
  }

  /** `await using archiver = createArchiver(...)` stops the loop on scope exit. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  async #checkAll(now: number): Promise<CheckOutcome[]> {
    const outcomes: CheckOutcome[] = [];
    for (const source of this.#sources.values()) {
      try {
        const outcome = await source.check(now);
        this.#report(outcome);
        outcomes.push(outcome);
      } catch (error) {
        this.emit('error', asError(error));
      }
    }
    return outcomes;
  }

  #report(outcome: CheckOutcome): void {
    if (!outcome.archived) {
      this.emit('skipped', {
        source: outcome.source,
        path: outcome.path,
        reason: outcome.reason,
      });
      return;
    }
    this.emit('archived', outcome.result);
    if (outcome.result.pruned.length > 0) {
      this.emit('pruned', { source: outcome.result.source, removed: outcome.result.pruned });
    }
  }
}

/**
 * Create and configure an archiver. Call `.start()` to begin checking.
 *
 * ```ts
 * const archiver = createArchiver({
 *   sources: [{ path: '/var/log/app.log', when: [size('10mb'), daily()] }],
 * }).start();
 * ```
 */
export function createArchiver(options: ArchiverOptions): Archiver {
  return new Archiver(options);
}

/** Archive a single file once, with no scheduler involved. */
export async function archiveFile(
  path: string,
  options: Omit<SourceConfig, 'path'> = {},
): Promise<ArchiveResult> {
  return new Source({ ...options, path }).archive('manual');
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
