/** Small filesystem helpers shared by the archival paths. */

import { createReadStream, createWriteStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { SourceStats } from '../types.js';

/**
 * Destroy a stream and wait for its descriptor to actually be gone.
 *
 * `destroy()` only starts the close. POSIX does not care — a file can be
 * unlinked or replaced while handles remain open — but Windows refuses both,
 * so anything that deletes or renames a file has to wait for this first.
 */
export async function closeStream(stream: {
  destroy: () => void;
  closed: boolean;
  once: (event: 'close', listener: () => void) => unknown;
}): Promise<void> {
  if (stream.closed) return;
  stream.destroy();
  await new Promise<void>((resolve) => stream.once('close', resolve));
}

/** `stat`, with "not there" as a value rather than an exception. */
export async function statOrNull(path: string): Promise<SourceStats | null> {
  try {
    const stats = await stat(path);
    return { size: stats.size, birthtimeMs: stats.birthtimeMs, mtimeMs: stats.mtimeMs };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** `true` for ENOENT, the one filesystem error this library treats as normal. */
export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Create a directory and every missing parent. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Create `path` (and its directory) as an empty file if it does not exist. */
export async function touch(path: string, mode?: number): Promise<void> {
  await ensureDir(dirname(path));
  const handle = await open(path, 'a', mode);
  await handle.close();
}

/** How much of a growing file is moved per read when draining it. */
const DRAIN_CHUNK = 64 * 1024;

/**
 * Recreate `path` as an empty file wearing the identity of the one that was
 * moved aside.
 *
 * The mode has to be applied after creation: `open`'s mode argument is filtered
 * through the process umask, which would silently narrow a log the writer
 * expects to stay group-writable. Ownership needs privilege to restore — when
 * we do not have it the file simply stays ours, which is what every other
 * rotation tool does too.
 */
export async function recreate(
  path: string,
  template: { mode: number; uid: number; gid: number },
): Promise<void> {
  await ensureDir(dirname(path));
  const handle = await open(path, 'a');
  try {
    await handle.chmod(template.mode & 0o7777);
    if (process.getuid?.() === 0) await handle.chown(template.uid, template.gid);
  } finally {
    await handle.close();
  }
}

/**
 * Append everything in `handle` from `offset` to its end onto `target`.
 *
 * Reads through one fixed-size buffer, so a writer that appends a gigabyte
 * while we work costs a gigabyte of IO and 64 KiB of memory. Returns the offset
 * it stopped at.
 */
export async function drainTo(handle: FileHandle, target: string, offset: number): Promise<number> {
  const buffer = Buffer.allocUnsafe(DRAIN_CHUNK);
  const out = await open(target, 'a');
  try {
    let position = offset;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return position;
      await out.write(buffer, 0, bytesRead);
      position += bytesRead;
    }
  } finally {
    await out.close();
  }
}

/**
 * Flush a directory entry so a rename into it survives a crash.
 *
 * Not every platform lets a directory be opened for this (Windows does not),
 * and there the rename is durable by other means — so an unsupported flush is
 * not an error.
 */
export async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // EINVAL/EPERM on filesystems that do not support directory fsync.
  } finally {
    await handle.close();
  }
}

/** Copy exactly the first `bytes` bytes of `from` to `to`. */
export async function copyPrefix(from: string, to: string, bytes: number): Promise<void> {
  if (bytes === 0) {
    await touch(to);
    return;
  }
  const sink = createWriteStream(to, { flags: 'w' });
  await pipeline(createReadStream(from, { start: 0, end: bytes - 1 }), sink);
  await closeStream(sink);
}
