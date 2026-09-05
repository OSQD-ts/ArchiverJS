/**
 * Archive destinations.
 *
 * The local filesystem store is the only one shipped, but everything above it
 * talks to the {@link ArchiveStore} interface, so pushing archives to object
 * storage is a user-land class rather than a fork.
 */

import { createWriteStream } from 'node:fs';
import { open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { closeStream, ensureDir, isNotFound, syncDirectory } from './internal/fs.js';
import type { ArchiveMetadata, ArchiveStore, StoredArchive } from './types.js';

/** Suffix worn by an archive that is still being written. */
const STAGING_SUFFIX = '.part';

/** Tuning for {@link LocalFileStore}. */
export interface LocalFileStoreOptions {
  /**
   * Permission bits for archives. Defaults to the source file's own mode, so a
   * log kept private stays private once archived.
   */
  mode?: number;
  /**
   * Flush each archive and the directory entry to disk before reporting
   * success. Defaults to `true`: the caller deletes its only other copy of the
   * data the moment `put` resolves, so "written" has to mean "survives a power
   * cut", not "is in the page cache".
   */
  fsync?: boolean;
}

/** Writes archives into a directory, creating it on first use. */
export class LocalFileStore implements ArchiveStore {
  readonly name = 'local';
  /** Absolute path of the archive directory. */
  readonly directory: string;

  readonly #mode: number | undefined;
  readonly #fsync: boolean;
  #ready: Promise<void> | null = null;

  constructor(directory: string, options: LocalFileStoreOptions = {}) {
    this.directory = resolve(directory);
    this.#mode = options.mode;
    this.#fsync = options.fsync ?? true;
  }

  async put(key: string, body: Readable, metadata: ArchiveMetadata): Promise<StoredArchive> {
    await this.#ensure();
    const location = join(this.directory, key);
    const staging = `${location}${STAGING_SUFFIX}`;
    const mode = (this.#mode ?? metadata.sourceMode) & 0o7777;

    // Claim the final name first — `wx` turns a collision into a loud failure
    // rather than an eaten archive — but write the bytes aside and swap them in
    // with a rename. A crash mid-compression then leaves an obvious `.part`
    // file instead of a truncated archive under a name that looks complete.
    const reservation = await open(location, 'wx', 0o600);
    await reservation.close();
    try {
      // The staging file is born with the final permissions, so a private log's
      // contents are never briefly readable by anyone else.
      const sink = createWriteStream(staging, { flags: 'w', mode });
      await pipeline(body, sink);
      // `pipeline` resolves once the bytes are handed over; the descriptor
      // closes just after, and Windows will not rename over a file that still
      // has one open.
      await closeStream(sink);
      const handle = await open(staging, 'r+');
      try {
        // `open`'s mode argument is filtered by the umask; set it explicitly.
        await handle.chmod(mode);
        if (this.#fsync) await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staging, location);
      // The rename itself lives in the directory entry, which needs its own
      // flush before the caller is told the archive is safely stored.
      if (this.#fsync) await syncDirectory(this.directory);
    } catch (error) {
      await rm(staging, { force: true });
      await rm(location, { force: true });
      throw error;
    }

    const written = await stat(location);
    return { key, location, bytes: written.size, createdAt: written.mtimeMs };
  }

  async list(prefix: string): Promise<StoredArchive[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const archives: StoredArchive[] = [];
    for (const entry of entries) {
      // A half-written archive is not an archive: it must not be listed, and
      // above all must not count towards a retention limit.
      if (!entry.startsWith(prefix) || entry.endsWith(STAGING_SUFFIX)) continue;
      const location = join(this.directory, entry);
      try {
        const stats = await stat(location);
        if (!stats.isFile()) continue;
        archives.push({ key: entry, location, bytes: stats.size, createdAt: stats.mtimeMs });
      } catch (error) {
        // Raced with another pruner; treat as already gone.
        if (!isNotFound(error)) throw error;
      }
    }
    return archives;
  }

  async remove(archive: StoredArchive): Promise<void> {
    await rm(archive.location, { force: true });
  }

  async has(key: string): Promise<boolean> {
    try {
      await stat(join(this.directory, key));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  #ensure(): Promise<void> {
    this.#ready ??= ensureDir(this.directory);
    return this.#ready;
  }
}

/** Pick a key that is free in `store`, disambiguating collisions with `.1`, `.2`, … */
export async function reserveKey(store: ArchiveStore, key: string): Promise<string> {
  if (!(await store.has(key))) return key;
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = `${key}.${suffix}`;
    if (!(await store.has(candidate))) return candidate;
  }
  // Practically unreachable: it would need 1000 archives in the same second.
  return `${key}.${Date.now()}`;
}
