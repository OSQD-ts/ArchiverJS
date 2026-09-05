/**
 * A standalone archiver process, used by the concurrency test.
 *
 * Has to be a real process, not a worker: the lock is keyed on the pid, and
 * threads all share one.
 *
 * It runs until it has completed a set number of rotations *and* the writer has
 * signalled that it is done, rather than for a fixed span of time. A loaded
 * machine then produces the same amount of contention as an idle one, just
 * more slowly — which is the difference between a test that measures the
 * library and one that measures the runner.
 *
 * `STRESS_NO_LOCK=1` disables locking, which is how the concurrency test's
 * claims were checked to be non-vacuous — without it, copy-truncate duplicates
 * hundreds of lines.
 */

import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Source } from '../../src/source.js';
import type { ArchiveStrategy } from '../../src/types.js';

const [path, destination, strategy, marker, minRotations] = process.argv.slice(2);

const source = new Source({
  path: path!,
  destination: destination!,
  strategy: strategy as ArchiveStrategy,
  compress: 'none',
  minSize: 1,
  lock: process.env.STRESS_NO_LOCK !== '1',
  filename: `{name}.${process.pid}.{index}{ext}`,
  retention: false,
});

const wanted = Number(minRotations);
// A backstop, so a wedged run fails the test rather than hanging CI forever.
const deadline = Date.now() + 60_000;
let rotations = 0;

while (Date.now() < deadline) {
  try {
    await source.archive('stress');
    rotations += 1;
  } catch {
    // Locked by a peer, or nothing to archive yet — both are normal here.
  }
  if (rotations >= wanted && existsSync(marker!)) break;
  await sleep(2);
}

process.stdout.write(String(rotations));
