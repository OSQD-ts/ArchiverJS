import { createReadStream, readdirSync, readlinkSync } from 'node:fs';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveFile } from '../src/archiver.js';
import { closeStream, drainTo, recreate } from '../src/internal/fs.js';
import { POSIX, tempDir } from './helpers.js';

describe('drainTo', () => {
  it('moves everything past the offset, across many read buffers', async () => {
    const dir = await tempDir();
    const from = join(dir, 'source');
    const to = join(dir, 'target');
    // 512 KiB of tail against a 64 KiB read buffer: eight full passes plus a
    // partial one, which is where an off-by-one in the loop would show up.
    const body = `head\n${'x'.repeat(64 * 1024 * 8 + 17)}`;
    await writeFile(from, body);
    await writeFile(to, 'already there\n');

    const handle = await open(from, 'r');
    try {
      const stopped = await drainTo(handle, to, 'head\n'.length);
      expect(stopped).toBe(body.length);
    } finally {
      await handle.close();
    }

    expect(await readFile(to, 'utf8')).toBe(`already there\n${body.slice('head\n'.length)}`);
  });

  it('is a no-op at end of file', async () => {
    const dir = await tempDir();
    const from = join(dir, 'source');
    const to = join(dir, 'target');
    await writeFile(from, 'abc');
    await writeFile(to, '');

    const handle = await open(from, 'r');
    try {
      expect(await drainTo(handle, to, 3)).toBe(3);
    } finally {
      await handle.close();
    }
    expect(await readFile(to, 'utf8')).toBe('');
  });
});

describe.skipIf(!POSIX)('recreate', () => {
  it('applies the mode the umask would otherwise have narrowed', async () => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');

    await recreate(path, { mode: 0o666, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 });

    expect((await stat(path)).mode & 0o777).toBe(0o666);
  });
});

describe('closeStream', () => {
  it('waits for the descriptor, not just the request to close it', async () => {
    const dir = await tempDir();
    const path = join(dir, 'file');
    await writeFile(path, 'body');

    const stream = createReadStream(path);
    expect(stream.closed).toBe(false);
    await closeStream(stream);
    expect(stream.closed).toBe(true);
  });

  it('is a no-op on a stream that is already closed', async () => {
    const dir = await tempDir();
    const path = join(dir, 'file');
    await writeFile(path, 'body');

    const stream = createReadStream(path);
    await closeStream(stream);
    await expect(closeStream(stream)).resolves.toBeUndefined();
  });
});

/**
 * A guard against leaking descriptors, not a stand-in for the Windows
 * behaviour it is related to. On Linux the fd closes within a tick either way,
 * so this passes whether or not the close is awaited; only a Windows run can
 * show that an unlink is refused while a handle is open. It still earns its
 * place: a descriptor left open across many rotations is its own bug.
 */
describe.skipIf(process.platform !== 'linux')('descriptor hygiene', () => {
  const openUnder = (dir: string): string[] =>
    readdirSync('/proc/self/fd').flatMap((fd) => {
      try {
        const target = readlinkSync(`/proc/self/fd/${fd}`);
        return target.startsWith(dir) ? [target] : [];
      } catch {
        return [];
      }
    });

  it.each(['none', 'gzip'] as const)('leaves nothing open after archiving (%s)', async (compress) => {
    const dir = await tempDir();
    const path = join(dir, 'app.log');
    await writeFile(path, 'x'.repeat(4096));

    const before = openUnder(dir);
    await archiveFile(path, { compress, destination: join(dir, 'archive') });

    expect(openUnder(dir)).toEqual(before);
  });
});
