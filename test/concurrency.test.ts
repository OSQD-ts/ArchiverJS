/**
 * Several archivers, one log, a writer that never stops.
 *
 * This is the scenario the lock exists for — two replicas on a shared volume,
 * or a cron job that overlaps the service already doing the job — and the only
 * way to test it honestly is with real processes, because the lock is keyed on
 * a pid that threads would share.
 */

import { spawn } from 'node:child_process';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { POSIX, tempDir } from './helpers.js';

const ROTATOR = fileURLToPath(new URL('./fixtures/rotator.mts', import.meta.url));

/**
 * tsx's own CLI, resolved through the package rather than assumed.
 *
 * `node --import tsx` would be tidier, but `--import` only arrived in Node
 * 18.19 and this package supports 18.17 — on which it is a hard "bad option"
 * failure. tsx's CLI picks the right hook for whatever Node is running it.
 */
const require = createRequire(import.meta.url);
const tsxPackage = require.resolve('tsx/package.json');
// `bin` is either a string or a map of names, depending on how the package
// declares it; tsx uses the string shorthand.
const { bin } = require(tsxPackage) as { bin: string | Record<string, string> };
const TSX_CLI = join(dirname(tsxPackage), typeof bin === 'string' ? bin : bin.tsx!);

/** Start a rotator; resolves with the number of rotations it completed. */
function startRotator(
  path: string,
  destination: string,
  strategy: string,
  marker: string,
  minRotations: number,
) {
  const child = spawn(
    process.execPath,
    [TSX_CLI, ROTATOR, path, destination, strategy, marker, String(minRotations)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return new Promise<number>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(Number(stdout))
        : reject(new Error(`rotator exited ${code}: ${stderr}`)),
    );
  });
}

/** Write `count` numbered lines the way a well-behaved logger does: one open per line. */
async function writeLines(path: string, count: number): Promise<string[]> {
  const lines = Array.from({ length: count }, (_, i) => `line-${String(i).padStart(5, '0')}`);
  for (const [i, line] of lines.entries()) {
    await appendFile(path, `${line}\n`);
    if (i % 25 === 0) await sleep(1);
  }
  return lines;
}

/**
 * Every line the archives and the live file hold.
 *
 * Deliberately unordered: the archives come from several processes and are
 * gathered in directory order, so the sequence here says nothing about the
 * order they were written in. What it does show is which lines survived, and
 * whether any of them appear twice or arrived torn.
 */
async function collect(archiveDir: string, live: string): Promise<string[]> {
  const files = await readdir(archiveDir).catch(() => []);
  const segments = await Promise.all(
    files.map(async (file) => {
      const body = await readFile(join(archiveDir, file), 'utf8');
      return { file, body };
    }),
  );
  // Archives are named `<name>.<pid>.<index>.log`; ordering across processes
  // comes from the contents themselves, which is what we are checking.
  const lines = segments
    .flatMap((segment) => segment.body.split('\n'))
    .concat((await readFile(live, 'utf8')).split('\n'))
    .filter((line) => line !== '');
  return lines;
}

// Windows refuses to rename a file another handle has open, which is a
// documented caveat of the `rename` strategy rather than something this test
// could meaningfully assert — there, the writer and the rotator collide by
// design and the run simply retries.
describe.skipIf(!POSIX)('competing archivers', () => {
  it(
    'never duplicate or corrupt a line under rename, and lose only to the reopen window',
    { timeout: 90_000 },
    async () => {
      const dir = await tempDir();
      const path = join(dir, 'app.log');
      const archiveDir = join(dir, 'archive');
      const marker = join(dir, 'writer.done');
      await writeFile(path, '');

      const rotators = [
        startRotator(path, archiveDir, 'rename', marker, 4),
        startRotator(path, archiveDir, 'rename', marker, 4),
        startRotator(path, archiveDir, 'rename', marker, 4),
      ];

      const written = await writeLines(path, 1500);
      await writeFile(marker, '');
      const rotations = await Promise.all(rotators);

      const lines = await collect(archiveDir, path);

      // Rename is atomic, so a line is never duplicated and never torn. These
      // two are absolute, and hold however slowly the machine is running.
      expect(new Set(lines).size).toBe(lines.length);
      for (const line of lines) expect(line).toMatch(/^line-\d{5}$/);

      // A line can still be lost: `appendFile` opens, writes and closes, and a
      // rename landing between the open and the write sends that line to the
      // inode we are about to archive and delete. That window is inherent to
      // rename-based rotation — it is why `copy-truncate` exists — and how
      // often it is hit depends on how the machine happens to schedule things,
      // so the bound here is a smoke check, not a measurement.
      expect(lines.length).toBeGreaterThan(written.length * 0.9);
      // And the contention was real, rather than three processes that never
      // got a turn.
      expect(Math.min(...rotations)).toBeGreaterThanOrEqual(4);
    },
  );

  it(
    'never duplicate or interleave a line under copy-truncate',
    { timeout: 90_000 },
    async () => {
      const dir = await tempDir();
      const path = join(dir, 'app.log');
      const archiveDir = join(dir, 'archive');
      const marker = join(dir, 'writer.done');
      await writeFile(path, '');

      const rotators = [
        startRotator(path, archiveDir, 'copy-truncate', marker, 4),
        startRotator(path, archiveDir, 'copy-truncate', marker, 4),
      ];

      const written = await writeLines(path, 1500);
      await writeFile(marker, '');
      const rotations = await Promise.all(rotators);

      const lines = await collect(archiveDir, path);

      // copy-truncate loses whatever is written between the final read and the
      // truncate. What must never happen is a line appearing twice, or a
      // partial line, which is exactly what unserialized rotations produce:
      // running the fixture with STRESS_NO_LOCK=1 duplicates several hundred
      // lines, which is the whole reason the lock exists.
      expect(new Set(lines).size).toBe(lines.length);
      for (const line of lines) expect(line).toMatch(/^line-\d{5}$/);
      expect(lines.length).toBeGreaterThan(written.length * 0.9);
      expect(Math.min(...rotations)).toBeGreaterThanOrEqual(4);
    },
  );
});
