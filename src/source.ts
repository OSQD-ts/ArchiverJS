/**
 * A resolved source: one file, its triggers, and the machinery that moves its
 * contents into the store.
 *
 * This is where the "seamless" part lives — detaching a file from a process
 * that is still writing to it, without losing bytes and without the writer
 * needing to cooperate.
 */

import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveCodec } from './compression.js';
import { ArchiveFailedError, ArchiverConfigError, ArchiverError, SourceLockedError } from './errors.js';
import { acquire, type Release } from './internal/lock.js';
import { closeStream, copyPrefix, drainTo, isNotFound, recreate, statOrNull } from './internal/fs.js';
import { applyRetention, resolveRetention, type ResolvedRetention } from './retention.js';
import { LocalFileStore, reserveKey } from './store.js';
import {
  DEFAULT_TEMPLATE,
  literalPrefix,
  nameMatcher,
  readIndex,
  renderName,
  splitName,
} from './template.js';
import { earliest, firstMatch, size } from './triggers.js';
import type {
  ArchiveResult,
  ArchiveStore,
  ArchiveStrategy,
  Codec,
  DetachedInfo,
  NameTemplate,
  SkipReason,
  SourceConfig,
  SourceStats,
  StoredArchive,
  Trigger,
  TriggerContext,
} from './types.js';
import { parseSize } from './units.js';

/** What a check did when it did not archive. */
export interface SkipOutcome {
  readonly archived: false;
  readonly source: string;
  readonly path: string;
  readonly reason: SkipReason;
}

/** What a check did when it archived. */
export interface ArchivedOutcome {
  readonly archived: true;
  readonly result: ArchiveResult;
}

export type CheckOutcome = SkipOutcome | ArchivedOutcome;

let temporaryCounter = 0;

/** Detached files this process is working on right now, so it never adopts its own. */
const inFlight = new Set<string>();

/** Stand-in release for sources that have opted out of locking. */
const NO_LOCK: Release = async () => {};

/** `true` if `pid` still exists — EPERM means it exists but belongs to someone else. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One configured file, ready to be checked and archived. */
export class Source {
  readonly name: string;
  readonly path: string;
  readonly triggers: readonly Trigger[];
  readonly store: ArchiveStore;
  readonly codec: Codec;
  readonly strategy: ArchiveStrategy;
  readonly filename: NameTemplate;
  readonly retention: ResolvedRetention | null;
  readonly minSize: number;
  readonly locking: boolean;

  readonly #onDetached: ((info: DetachedInfo) => void | Promise<void>) | undefined;
  readonly #onWarning: ((error: Error) => void) | undefined;

  /**
   * Archives this process has written, oldest first.
   *
   * Only consulted for filename templates that cannot be matched from the
   * outside, and capped so a process that rotates forever with retention
   * disabled does not grow a list forever either.
   */
  readonly #written: StoredArchive[] = [];
  readonly #prefix: string;
  readonly #matcher: RegExp | null;
  #lastArchivedAt: number | null = null;
  #running: Promise<ArchiveResult> | null = null;
  #primed: Promise<void> | null = null;

  constructor(config: SourceConfig) {
    if (typeof config.path !== 'string' || config.path.trim() === '') {
      throw new ArchiverConfigError('source.path is required');
    }
    this.path = resolve(config.path);
    this.name = config.name ?? basename(this.path);
    const triggers = config.when ?? size('10mb');
    this.triggers = Array.isArray(triggers) ? triggers : [triggers];
    if (this.triggers.length === 0) {
      throw new ArchiverConfigError(`source '${this.name}': 'when' must contain a trigger`);
    }
    if (config.store && config.destination) {
      throw new ArchiverConfigError(
        `source '${this.name}': set either 'store' or 'destination', not both`,
      );
    }
    this.store = config.store ?? new LocalFileStore(config.destination ?? dirname(this.path));
    this.codec = resolveCodec(config.compress);
    this.strategy = config.strategy ?? 'rename';
    this.filename = config.filename ?? DEFAULT_TEMPLATE;
    this.retention = resolveRetention(config.retention);
    this.minSize = config.minSize === undefined ? 1 : parseSize(config.minSize, 'minSize');
    this.locking = config.lock ?? true;
    this.#onDetached = config.onDetached;
    this.#onWarning = config.onWarning;

    const { name, ext } = splitName(basename(this.path));
    this.#prefix = literalPrefix(this.filename, name, ext);
    this.#matcher = nameMatcher(this.filename, name, ext);
  }

  /** When this source was last archived by this process. */
  get lastArchivedAt(): number | null {
    return this.#lastArchivedAt;
  }

  /** `true` while an archival run is in flight. */
  get busy(): boolean {
    return this.#running !== null;
  }

  /**
   * Recover what this source knows from the archives already in the store.
   *
   * `lastArchivedAt` anchors the cadence triggers, and holding it only in
   * memory would mean every restart re-armed `daily()` from scratch — rotating
   * twice in a day, or not at all. The newest archive in the store answers the
   * question without a state file of its own, and works for any store.
   */
  prime(): Promise<void> {
    // Share the promise rather than a boolean: a second caller arriving while
    // the listing is still in flight must wait for the answer, not skip past it
    // and evaluate its triggers against an anchor that is not there yet.
    this.#primed ??= this.#prime();
    return this.#primed;
  }

  async #prime(): Promise<void> {
    if (this.#lastArchivedAt !== null) return;
    try {
      let newest: number | null = null;
      for (const archive of await this.listArchives()) {
        if (newest === null || archive.createdAt > newest) newest = archive.createdAt;
      }
      if (this.#lastArchivedAt === null) this.#lastArchivedAt = newest;
    } catch {
      // A store that cannot be listed simply has no history to recover.
    }
  }

  /** Evaluate the triggers and archive if any of them fires. */
  async check(now = Date.now()): Promise<CheckOutcome> {
    if (this.#running) return this.#skip('busy');
    await this.prime();

    const stats = await statOrNull(this.path);
    if (!stats) return this.#skip('missing');
    if (stats.size < this.minSize) return this.#skip('too-small');

    const fired = this.shouldArchive(stats, now);
    if (!fired) return this.#skip('no-trigger');

    try {
      return { archived: true, result: await this.archive(fired.name, now) };
    } catch (error) {
      // Another archiver got there first: that is the lock doing its job, not a
      // failure worth waking anyone up for.
      if (error instanceof ArchiveFailedError && error.cause instanceof SourceLockedError) {
        return this.#skip('locked');
      }
      throw error;
    }
  }

  /**
   * Ask the triggers about stats you already hold — used by the rotating
   * stream, which knows the file's size without a syscall.
   */
  shouldArchive(stats: SourceStats | null, now = Date.now()): Trigger | null {
    if (!stats || stats.size < this.minSize) return null;
    return firstMatch(this.triggers, {
      path: this.path,
      stats,
      now,
      lastArchivedAt: this.#lastArchivedAt,
    });
  }

  /** Archive right now, whatever the triggers think. Concurrent calls share one run. */
  archive(reason = 'manual', now = Date.now()): Promise<ArchiveResult> {
    // A manual call landing mid-rotation joins the run in flight rather than
    // racing it for the same file.
    this.#running ??= this.#run(reason, now).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /**
   * When this source is next expected to be archived, or `null` if no trigger
   * will commit to a time.
   *
   * Time-based triggers know their own schedule; `size()` cannot, since that
   * depends on how fast the file grows. Intended for monitoring and for
   * answering "why has this not rotated yet?", not for driving the loop.
   */
  async nextDueAt(now = Date.now()): Promise<number | null> {
    await this.prime();
    const context: TriggerContext = {
      path: this.path,
      stats: await statOrNull(this.path),
      now,
      lastArchivedAt: this.#lastArchivedAt,
    };
    return earliest(this.triggers, context);
  }

  /** Every archive of this source the store still holds, best-effort. */
  async listArchives(): Promise<StoredArchive[]> {
    const listed = await this.store.list(this.#prefix);
    if (this.#matcher) return listed.filter((archive) => this.#matcher!.test(archive.key));
    // A function template is unknowable from the outside, so fall back to what
    // this process wrote — never delete a file we cannot prove is ours.
    const ours = new Set(this.#written.map((archive) => archive.key));
    return listed.filter((archive) => ours.has(archive.key));
  }

  #remember(archive: StoredArchive): void {
    this.#written.push(archive);
    if (this.#written.length > 1000) this.#written.splice(0, this.#written.length - 1000);
  }

  #skip(reason: SkipReason): SkipOutcome {
    return { archived: false, source: this.name, path: this.path, reason };
  }

  async #run(reason: string, now: number): Promise<ArchiveResult> {
    const startedAt = Date.now();
    // Follow symlinks: rotating `/var/log/app.log -> /mnt/logs/app.log` must
    // move the file it points at, not replace the link with a regular file.
    const live = await this.#livePath();
    // Named up front so the failure path knows where to look even if the
    // detach itself is what died.
    const temporary = `${live}.archiving-${process.pid}-${(temporaryCounter += 1)}`;
    let release: Release | null = null;

    try {
      // The lock is judged by wall-clock age, so it gets the real time even
      // when the caller is evaluating triggers against a notional `now`.
      release = this.locking ? await acquire(live, Date.now()) : NO_LOCK;
      if (!release) throw new SourceLockedError(this.path);

      // Contents a previous run could not store are archived first, so the
      // history stays in order.
      await this.#adoptOrphans(live, now);

      const stats = await stat(live);
      const sourceBytes = stats.size;
      await this.#detach(live, temporary, stats);
      inFlight.add(temporary);
      await this.#announceDetached(temporary, sourceBytes);

      const key = await this.#nextKey(now);
      const archive = await this.#upload(key, temporary, stats, now);
      this.#remember(archive);
      this.#lastArchivedAt = now;

      await rm(temporary, { force: true });
      inFlight.delete(temporary);

      const pruned = await this.#prune(now);
      return {
        source: this.name,
        path: this.path,
        archive,
        sourceBytes,
        archiveBytes: archive.bytes,
        compression: this.codec.name,
        reason,
        durationMs: Date.now() - startedAt,
        pruned,
      };
    } catch (error) {
      const retained = await this.#recover(live, temporary);
      inFlight.delete(temporary);
      throw new ArchiveFailedError(this.path, error, retained);
    } finally {
      await release?.();
    }
  }

  /**
   * Tell the hook the bytes are out, as early as possible.
   *
   * Deliberately before compression and upload: for a writer that has to be
   * signalled to reopen, every millisecond between the detach and the signal is
   * a millisecond of writes going into a file that is about to be deleted.
   */
  async #announceDetached(detached: string, bytes: number): Promise<void> {
    if (!this.#onDetached) return;
    try {
      await this.#onDetached({
        source: this.name,
        // The configured path, matching every other payload we hand out. The
        // resolved one is an implementation detail, and differs per platform:
        // macOS reports /private/var for /var, Windows expands 8.3 short names.
        path: this.path,
        detachedPath: detached,
        bytes,
        strategy: this.strategy,
      });
    } catch (error) {
      // The contents are already out; storing them matters more than the hook.
      this.#warn(error, `onDetached hook for '${this.name}' failed`);
    }
  }

  #warn(cause: unknown, context: string): void {
    if (!this.#onWarning) return;
    const error = new ArchiverError(`${context}: ${cause instanceof Error ? cause.message : String(cause)}`, 'ERR_ARCHIVER_WARNING', { cause });
    try {
      this.#onWarning(error);
    } catch {
      // A broken warning handler is not going to be reported through itself.
    }
  }

  /** The real file behind {@link path}, or the path itself when it does not exist yet. */
  async #livePath(): Promise<string> {
    try {
      return await realpath(this.path);
    } catch (error) {
      if (isNotFound(error)) return this.path;
      throw error;
    }
  }

  /**
   * Archive whatever an earlier run detached but could not store.
   *
   * A crash — or a store that was down — leaves the bytes in a temporary file
   * next to the source rather than destroying them. Picking them up here is
   * what makes that recovery automatic instead of a note in a log nobody reads.
   * Files belonging to a process that is still alive are left alone: that is
   * another archiver mid-run, not debris.
   */
  async #adoptOrphans(live: string, now: number): Promise<void> {
    const directory = dirname(live);
    const prefix = `${basename(live)}.archiving-`;
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    const orphans: Array<{ path: string; createdAt: number; bytes: number; mode: number }> = [];
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const owner = Number(entry.slice(prefix.length).split('-')[0]);
      const path = join(directory, entry);
      if (inFlight.has(path)) continue;
      if (Number.isFinite(owner) && owner !== process.pid && isProcessAlive(owner)) continue;
      const stats = await statOrNull(path);
      if (stats && stats.size > 0) {
        orphans.push({ path, createdAt: stats.mtimeMs, bytes: stats.size, mode: 0o600 });
      } else if (stats) {
        await rm(path, { force: true });
      }
    }

    // Oldest first, so the archive reads chronologically.
    orphans.sort((a, b) => a.createdAt - b.createdAt);
    for (const orphan of orphans) {
      const key = await this.#nextKey(orphan.createdAt);
      const archive = await this.#upload(
        key,
        orphan.path,
        { size: orphan.bytes, mode: orphan.mode } as Stats,
        orphan.createdAt,
      );
      this.#remember(archive);
      await rm(orphan.path, { force: true });
    }
    if (orphans.length > 0) await this.#prune(now);
  }

  /**
   * Separate the current contents from the live file, leaving them in
   * `temporary`.
   *
   * Tracks whether the live file has actually given the bytes up yet, because
   * the two failure modes need opposite treatment. Once it has, the temporary
   * file is the only copy and must survive at all costs. Before that, the live
   * file still holds everything and the half-written copy has to go — left
   * behind, a later run would adopt it and archive the same lines twice.
   */
  async #detach(live: string, temporary: string, stats: Stats): Promise<void> {
    let committed = false;
    try {
      if (this.strategy === 'rename') {
        // Atomic: the writer's next `open()` lands on a fresh, empty file, and
        // nothing written before this instant can be lost. The replacement has
        // to inherit the original's mode and ownership, or a writer running as
        // another user loses access to its own log on the next reopen.
        await rename(live, temporary);
        committed = true;
        await recreate(live, { mode: stats.mode, uid: stats.uid, gid: stats.gid });
        return;
      }

      // copy-truncate: the writer keeps its descriptor, so the file must stay
      // the same inode. Copy the bytes we measured, then keep draining whatever
      // was appended while we copied — those bytes join the archive in order
      // rather than being buffered and written back, so memory stays flat
      // however fast the writer is. What remains of the classic copytruncate
      // race is the instant between the final read and the truncate.
      await copyPrefix(live, temporary, stats.size);
      const handle = await open(live, 'r+');
      try {
        await drainTo(handle, temporary, stats.size);
        await handle.truncate(0);
        committed = true;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #upload(
    key: string,
    detached: string,
    stats: Pick<Stats, 'size' | 'mode'>,
    now: number,
  ): Promise<StoredArchive> {
    const metadata = {
      sourcePath: this.path,
      sourceBytes: stats.size,
      archivedAt: now,
      compression: this.codec.name,
      // Carried so the store can keep a private log private.
      sourceMode: stats.mode & 0o7777,
    };
    const body = createReadStream(detached);
    const compressor = this.codec.createCompressor();
    // Whatever happens next, the caller deletes `detached` the moment this
    // returns, and Windows will not unlink a file anything still has open.
    if (!compressor) {
      try {
        return await this.store.put(key, body, metadata);
      } finally {
        await closeStream(body);
      }
    }

    // The store owns the read end; wire the failure paths in both directions so
    // neither half can be left dangling when the other one dies. The listener
    // on the compressor is not optional: bytes start flowing the moment we
    // pipe, but the store is still opening its destination, so a codec that
    // fails immediately would emit `'error'` with nobody attached — and an
    // unhandled `'error'` event takes the whole process down. The store's
    // `pipeline` still sees the failure through the stream's error state.
    body.on('error', (error) => compressor.destroy(error));
    compressor.on('error', () => body.destroy());
    compressor.on('close', () => body.destroy());
    body.pipe(compressor);
    try {
      return await this.store.put(key, compressor, metadata);
    } finally {
      await closeStream(body);
    }
  }

  async #nextKey(now: number): Promise<string> {
    const { name, ext } = splitName(basename(this.path));
    // Only pay for a listing when the template actually needs a sequence.
    const needsIndex = typeof this.filename !== 'string' || /\{(index|seq)\}/.test(this.filename);
    const index = needsIndex ? await this.#nextIndex() : 1;
    const rendered = renderName(this.filename, {
      name,
      ext,
      date: new Date(now),
      index,
      compressExt: this.codec.extension,
    });
    return reserveKey(this.store, rendered);
  }

  /**
   * One past the highest sequence number already on disk.
   *
   * Counting the archives instead would restart the sequence every time
   * retention deleted one, and collide with the names still there.
   */
  async #nextIndex(): Promise<number> {
    const archives = await this.listArchives();
    if (!this.#matcher) return archives.length + 1;
    let highest = 0;
    for (const archive of archives) {
      const index = readIndex(this.#matcher, archive.key);
      if (index !== null && index > highest) highest = index;
    }
    return highest + 1;
  }

  /**
   * Apply retention, and never let it fail the run.
   *
   * By this point the archive is safely stored and the source is empty — the
   * work that mattered is done. Reporting a failed delete as a failed archival
   * would invite the caller to retry and produce a second copy of the same
   * bytes. Retention re-derives everything from the store each time, so a
   * failure here simply corrects itself on the next rotation.
   */
  async #prune(now: number): Promise<StoredArchive[]> {
    if (!this.retention) return [];
    try {
      return await this.#pruneUnsafely(now);
    } catch (error) {
      this.#warn(error, `retention for '${this.name}' could not delete old archives`);
      return [];
    }
  }

  async #pruneUnsafely(now: number): Promise<StoredArchive[]> {
    const archives = await this.listArchives();
    const removed = await applyRetention(this.store, archives, this.retention!, now);
    if (removed.length > 0) {
      const gone = new Set(removed.map((archive) => archive.key));
      for (let i = this.#written.length - 1; i >= 0; i -= 1) {
        if (gone.has(this.#written[i]!.key)) this.#written.splice(i, 1);
      }
    }
    return removed;
  }

  /**
   * Deal with contents that have already left the live file when a run fails.
   *
   * The one thing this must never do is destroy data to leave a tidy directory.
   * If the file was moved aside and nothing has been written in its place, the
   * original goes straight back. Otherwise — always, under `copy-truncate`,
   * where another process is appending to the very file we would have to
   * truncate again to make room — the bytes stay on disk, and the next run
   * picks them up. Returns where they were left, or `null` if there is nothing
   * out there: either it went home, or the detach cleaned up after itself.
   *
   * Nothing in here may throw. It runs while an error is already on its way
   * out, and masking that error with a second one helps nobody.
   */
  async #recover(live: string, temporary: string): Promise<string | null> {
    try {
      if ((await statOrNull(temporary)) === null) return null;
      if (this.strategy === 'rename') {
        const replacement = await statOrNull(live);
        if (replacement === null || replacement.size === 0) {
          await rename(temporary, live);
          return null;
        }
      }
      return (await statOrNull(temporary)) === null ? null : temporary;
    } catch {
      // Restoring is best-effort; keeping the detached copy is the guarantee.
      return (await statOrNull(temporary).catch(() => null)) === null ? null : temporary;
    }
  }
}
