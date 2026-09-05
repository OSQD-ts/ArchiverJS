/**
 * The stream case: the program writes its own log and the file rotates itself.
 *
 *   npx tsx examples/logs.ts
 */

import { createRotatingStream, daily, formatBytes, size } from '../src/index.js';

const log = createRotatingStream({
  path: new URL('../.tmp/logs/app.log', import.meta.url).pathname,
  // Roll at 8 KiB, or at midnight, whichever comes first.
  when: [size('8kb'), daily('00:00')],
  compress: 'gzip',
  retention: { maxFiles: 5, maxAge: '30d' },
});

log.on('archived', (result) => {
  console.log(
    `archived ${result.reason}: ${formatBytes(result.sourceBytes)} → ` +
      `${formatBytes(result.archiveBytes)} at ${result.archive.location}`,
  );
});
log.on('pruned', ({ removed }) => {
  console.log(`pruned ${removed.length} old archive(s)`);
});
log.on('archive-error', (error) => {
  // Logging keeps working even when archival does not.
  console.error('archival failed:', error.message);
});

for (let i = 0; i < 400; i += 1) {
  log.write(`${new Date().toISOString()} request ${i} handled\n`);
}

log.end(() => console.log(`live log is now ${formatBytes(log.size)}`));
