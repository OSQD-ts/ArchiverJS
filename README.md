# archiverjs

[`@osqd/archiverjs`](https://www.npmjs.com/package/@osqd/archiverjs) — seamless automatic archival
for TypeScript and Node.js.

Files that a running program keeps appending to — logs, exports, audit trails — grow without
limit until someone notices. `archiverjs` watches them and, when a rule fires (too big, too old,
end of the day), moves the contents into a compressed archive, prunes the history, and lets the
program carry on writing. No cron, no `logrotate`, no shell, no restart.

- **Two entry points.** A `Writable` stream that rotates itself, or a watcher for files written by
  something else.
- **Configurable rules.** Size, age, cadence, time of day, or your own predicate — combined with
  `any` / `all`.
- **Compression.** gzip, brotli, deflate, zstd, or a codec you supply. Streamed, so a 4 GB log is
  never held in memory.
- **Retention.** Keep the last _n_ archives, everything from the last _n_ days, or up to _n_ bytes.
- **Zero runtime dependencies.** Everything comes from `node:zlib`, `node:fs`, `node:stream`.
- **Safe when things go wrong.** Contents are never destroyed to make an error tidy, archives are
  published atomically and flushed to disk, permissions are preserved, and a second archiver
  cannot rotate the same file underneath you.
- **Typed throughout**, dual ESM/CJS, `strict` TypeScript.

```bash
npm install @osqd/archiverjs
```

Requires Node 18.17 or newer (zstd needs Node 22.15+).

## The program writes the log itself

Give it a stream and forget about it. The stream owns the file descriptor, so it can close,
rename and reopen atomically — nothing is lost and nothing is duplicated.

```ts
import { createRotatingStream, size, daily } from '@osqd/archiverjs';

const log = createRotatingStream({
  path: 'logs/app.log',
  when: [size('10mb'), daily('00:00')], // whichever comes first
  compress: 'gzip',
  retention: { maxFiles: 14, maxAge: '30d' },
});

log.write(`${new Date().toISOString()} server started\n`);

log.on('archived', (result) => {
  console.log(`rotated (${result.reason}) → ${result.archive.location}`);
});
```

The live file never exceeds the size you asked for: a write that would overflow the limit
triggers the rotation first. Batched writes are split at the boundary rather than landing as one
oversized segment.

It is a plain `Writable`, so it drops straight into a logger:

```ts
import pino from 'pino';

const logger = pino(createRotatingStream({ path: 'logs/app.log', when: size('50mb') }));
```

## Something else writes the file

Point an archiver at the path and let it poll.

```ts
import { createArchiver, size, age } from '@osqd/archiverjs';

const archiver = createArchiver({
  sources: [
    { path: '/var/log/app/access.log', when: [size('100mb'), age('1d')] },
    { path: '/var/log/app/error.log', when: size('10mb'), retention: { maxAge: '90d' } },
  ],
  defaults: {
    destination: '/var/log/app/archive',
    compress: 'zstd',
    strategy: 'copy-truncate', // the writer holds its own descriptor
  },
  checkInterval: '30s',
}).start();

archiver.on('archived', ({ source, sourceBytes, archiveBytes }) => {
  console.log(`${source}: ${sourceBytes} → ${archiveBytes} bytes`);
});
```

`start()` schedules an unreferenced timer, so an archiver never keeps a process alive. Pass
`keepAlive: true` if you want it to.

Polling is deliberate. `fs.watch` gives no signal for "this file is now a day old", fires storms
of events for a busy log, and behaves differently on every platform and network mount; a `stat`
every thirty seconds is cheaper than any of that.

### One file, once

```ts
import { archiveFile } from '@osqd/archiverjs';

const result = await archiveFile('reports/2026-Q1.csv', {
  destination: 'reports/archive',
  compress: 'brotli',
  retention: false,
});
```

## Choosing a strategy

The hard part of archiving a file that someone is still writing to is detaching the bytes without
losing any. There are two ways, and which one is correct depends on who holds the descriptor.

| | `rename` (default) | `copy-truncate` |
| --- | --- | --- |
| How | Move the file aside, create a fresh one in its place | Copy the contents out, then truncate the file in place |
| Cost | One `rename`, whatever the file's size | Copies every byte |
| Loses data | Never *if the writer reopens* (see below) | A very small race window (see below) |
| Keeps mode and owner | Restored onto the replacement | Untouched — same inode |
| Foreign writer with an open fd | Keeps writing into the moved-away file until it reopens | Keeps working, untouched |
| Use it when | The writer is this library, or a logger that reopens on `SIGHUP` | You do not control the writer |

`rename` is atomic and free, which is why it is the default and why the rotating stream always
uses it. **It is lossless only for a writer that reopens the file.** The rotating stream qualifies
by construction: it closes its own descriptor, rotates, and reopens, so no write can fall between
the two.

A writer you do not control does not qualify, and the failure is quieter than it looks. A process
that opened the file before the rename holds a descriptor to the moved inode; whatever it writes
there lands in the archive if it arrives before we finish reading, and is **lost** if it arrives
after, because that file is then deleted. Even `fs.appendFile`, which opens and closes per call, can
lose a line when the rename lands between its open and its write — measured at roughly one line in
four thousand under deliberate contention (`test/concurrency.test.ts`). This is the same window
`logrotate` has, and the reason `copytruncate` exists.

So: `rename` for this library's stream, or for a logger you signal promptly. `copy-truncate` for
everything else.

If you do signal a writer, use the `onDetached` hook rather than the `archived` event. The hook
fires the instant the file has been moved aside and is awaited before compression even starts; the
event does not fire until the archive has been compressed and stored, and every millisecond in
between is more writes going into a file that is about to be deleted.

```ts
{
  path: '/var/log/nginx/access.log',
  strategy: 'rename',
  // The first thing that happens after the rename, not the last.
  onDetached: () => process.kill(nginxPid, 'SIGHUP'),
}
```

A hook that throws does not cost you the archive — the bytes are already out, and storing them
matters more than the signal. The failure arrives on `warning` instead.

The replacement file inherits the original's permission bits, and its owner too when the archiver
runs as root. Both matter more than they look: `open`'s mode argument is filtered through the
process umask, so a naive recreate hands a `0666` log back as `0664`, and a root-owned replacement
locks out a writer running as `www-data` the moment it reopens.

`copy-truncate` keeps the inode, so any descriptor stays valid. The classic weakness is that
anything written between the copy and the truncate is lost. `archiverjs` narrows that: after
copying the bytes it measured, it keeps draining whatever the writer appended in the meantime —
those bytes join the archive in order — and only then truncates. Memory stays flat however fast
the writer is, and what remains of the race is the instant between the final read and the
truncate. The other caveat is inherent to the technique: a writer holding a non-append descriptor
(its own file offset) writes at its old offset after the truncate, leaving a sparse hole.

## Triggers

A trigger is a pure predicate over the file's stats. An array means "any of these".

```ts
import { size, age, every, daily, when, any, all } from '@osqd/archiverjs';

size('10mb')        // at or above 10 MiB (kb/mb/gb are 1024-based)
age('7d')           // the file itself is older than 7 days
every('1h')         // an hour since the last rotation — or since the file appeared
daily('00:00')      // once a day, at midnight local time
when('friday', (c) => new Date(c.now).getDay() === 5)

all(size('1mb'), age('1d'))   // big *and* old
any(size('1gb'), daily())     // either
```

Writing your own is one function:

```ts
const containsFatal: Trigger = {
  name: 'fatal',
  test: (context) => context.stats !== null && seenFatalSince(context.lastArchivedAt),
};
```

## Naming

The default template is `{name}-{timestamp}{ext}{compressExt}` — `app-2026-09-05T14-31-07.log.gz`,
which sorts chronologically as text.

| Token | Example |
| --- | --- |
| `{name}` `{ext}` | `app`, `.log` |
| `{date}` `{time}` `{timestamp}` | `2026-09-05`, `14-31-07`, `2026-09-05T14-31-07` |
| `{epoch}` | `1788697867000` |
| `{index}` `{seq}` | `7`, `007` — one past the highest already on disk |
| `{pid}` | `4242` |
| `{compressExt}` | `.gz` |

A function works too:

```ts
filename: ({ name, date }) => `${name}.${date.getFullYear()}.log`,
```

Its result is flattened to a single path segment, so an archive can never escape its destination.

If a name is already taken, `.1`, `.2`, … are appended rather than overwriting anything.

## Retention

```ts
retention: {
  maxFiles: 10,        // keep the newest 10
  maxAge: '30d',       // drop anything older
  maxTotalSize: '1gb', // keep the set under a budget
}
```

Every limit that is set is applied and the results unioned — surviving the file count does not
exempt an archive from the age limit. The archive just written is never deleted. `retention: false`
disables pruning; the default is `{ maxFiles: 10 }`.

Pruning only ever considers filenames the source's own template could have produced, so an
unrelated file sharing the archive directory is never touched. With a function template that
cannot be known, so pruning falls back to the archives this process wrote itself.

## Somewhere other than the local disk

Implement `ArchiveStore` and pass it as `store`:

```ts
import type { ArchiveStore } from '@osqd/archiverjs';

const s3: ArchiveStore = {
  name: 's3',
  async put(key, body, metadata) { /* upload the stream */ },
  async list(prefix) { /* … */ },
  async remove(archive) { /* … */ },
  async has(key) { /* … */ },
};

createArchiver({ sources: [{ path: '/var/log/app.log', store: s3 }] });
```

The body arrives as a readable stream, already compressed.

## Events

| Event | Fires when |
| --- | --- |
| `archived` | A file was archived. Carries sizes, the trigger's name, duration, and what was pruned. |
| `skipped` | A check did nothing (`missing`, `too-small`, `no-trigger`, `busy`). |
| `pruned` | Retention deleted archives. |
| `warning` | Something failed that did not cost you the archive — a hook that threw, a retention delete that did not happen. |
| `error` (archiver) / `archive-error` (stream) | A run failed. |

The rotating stream reports archival failures as `archive-error`, not `error`: a failed archive
must not take down an application's logging, and an unhandled `'error'` on a stream throws. Its
`'error'` stays what it means everywhere else — the write itself failed.

Failures never leave a hole. If a run dies after the file was moved aside, the contents are put
back; if that is not safe, the detached copy is left on disk next to the source and named in the
error.

An archive is published atomically: the bytes are written to a `.part` file and renamed into place
only once they are all there. A crash mid-compression leaves an obvious `.part` behind rather than
a truncated archive under a name that looks complete — and a `.part` is never listed, so it can
never count towards a retention limit.

## API

| | |
| --- | --- |
| `createArchiver(options)` → `Archiver` | Watch a set of sources. `.start()`, `.stop()`, `.check()`, `.archive(name)`, `.archiveAll()`, `.add()`, `.remove()`, `.schedule()` |
| `createRotatingStream(options)` → `RotatingFileStream` | A self-archiving `Writable`. `.rotate()`, `.size`, `.path` |
| `archiveFile(path, options)` → `ArchiveResult` | Archive one file once |
| `source.nextDueAt()` | When this source is next expected to roll, or `null` if only size decides |
| `onDetached(info)` | Hook fired the moment the contents leave the live file, awaited before the upload starts |
| `size` `age` `every` `daily` `when` `any` `all` | Triggers |
| `LocalFileStore` | The default store — `{ mode, fsync }` |
| `ArchiveFailedError` | `.path`, `.retained`, `.cause` |
| `SourceLockedError` | Attached as `.cause` when another process holds the lock |
| `parseSize` `parseDuration` `formatBytes` | Unit helpers |

An archiver is disposable: `await using archiver = createArchiver({ … }).start()` stops the loop
on scope exit.

## What happens when things go wrong

Archival is only worth automating if it is safe to walk away from, so the failure paths carry the
same weight as the happy one.

**Contents are never destroyed to tidy up an error.** If a run fails after the bytes have left the
live file — a full disk, a store outage, a codec blowing up — they are put back when that is safe,
and otherwise left on disk in a `.archiving-*` file next to the source. The thrown
`ArchiveFailedError` carries the path as `retained`. The next successful run picks that file up and
archives it *before* the current contents, so the history stays in order and the recovery needs no
operator.

```ts
try {
  await archiver.archive('app');
} catch (error) {
  if (error instanceof ArchiveFailedError && error.retained) {
    console.error(`archive failed; log contents are safe at ${error.retained}`);
  }
}
```

**A crash cannot leave a half-written archive that looks complete.** Bytes go to a `.part` file
which is renamed into place only once all of them are there. A `.part` is never listed, so it can
never count towards a retention limit or be mistaken for history.

**"Stored" means stored.** The local store flushes the archive and its directory entry to disk
before reporting success — the caller deletes its only other copy the moment `put` resolves, so
that has to survive a power cut, not just reach the page cache. Pass `fsync: false` to
`LocalFileStore` if you would rather have the throughput.

**Private logs stay private.** Archives inherit the source file's permission bits, so a `0600` log
does not become a `0644` archive sitting next to it. The staging file is created with the final
mode, so the contents are never briefly world-readable either. Override with
`new LocalFileStore(dir, { mode: 0o640 })`.

**Two archivers cannot fight over one file.** Each run takes a lock file next to the source. A
second archiver — another replica, a stray cron job, a service restarted before the old one
exited — is told to come back later (`skipped` with reason `locked`) rather than interleaving its
rotation with yours. A lock whose owner no longer exists is cleared automatically, so a crash
cannot wedge a log. Set `lock: false` to opt out.

**A restart does not lose the schedule.** `daily()` and `every()` recover their anchor from the
newest archive already in the store, so a deploy at 23:59 does not rotate twice, and an hourly
cadence resumes where it left off. No state file is involved — the archives *are* the state.

## Caveats

- **`rename` is not lossless for a writer you do not control.** It is for this library's stream,
  and for a logger you signal promptly. For anything else, use `copy-truncate` — see
  [Choosing a strategy](#choosing-a-strategy).
- **Windows.** `rename` fails on a file another process holds open — use `copy-truncate` there
  when the writer is not this library.
- **Trigger evaluation is not free of the clock.** `daily` and `age` use local time, so a DST
  shift moves the cutoff by an hour.
- **A rotation that takes longer than a day** will have its lock treated as abandoned, because a
  live pid is not proof of liveness once pids get recycled. If you archive files that big, turn
  locking off and serialize the runs yourself.
- **Locking needs a writable source directory.** So does rotating, for what it is worth — but if
  yours is read-only for some other reason, `lock: false`.

## Development

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # dual ESM + CJS into dist/
npx tsx examples/logs.ts
```

## License

OSQD Non-Resale License, Version 1.0 — see [LICENSE](LICENSE). Free to use, modify and distribute;
selling it, or a derivative of it, as a product in its own right is not permitted.
