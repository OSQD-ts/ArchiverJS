/**
 * The watcher case: some other process writes the file, we archive underneath
 * it without asking it to cooperate.
 *
 *   npx tsx examples/watch.ts
 */

import { appendFile } from 'node:fs/promises';
import { age, createArchiver, formatBytes, size } from '../src/index.js';

const logDir = new URL('../.tmp/watched/', import.meta.url).pathname;

const archiver = createArchiver({
  sources: [
    { path: `${logDir}access.log`, when: [size('4kb'), age('1d')] },
    { path: `${logDir}error.log`, when: size('1mb'), retention: { maxAge: '90d' } },
  ],
  defaults: {
    destination: `${logDir}archive`,
    compress: 'gzip',
    // The writer holds its own descriptor, so keep the inode and truncate it.
    strategy: 'copy-truncate',
  },
  checkInterval: '1s',
});

archiver.on('archived', (result) =>
  console.log(`${result.source}: ${formatBytes(result.sourceBytes)} → ${result.archive.key}`),
);
archiver.on('error', (error) => console.error(error.message));

archiver.start();

// Stand in for the foreign process that writes the log.
for (let i = 0; i < 300; i += 1) {
  await appendFile(`${logDir}access.log`, `${new Date().toISOString()} GET / 200\n`);
}

await archiver.check();
await archiver.stop();
