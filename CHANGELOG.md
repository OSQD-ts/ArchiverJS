# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-05

### Added

- Initial release: automatic archival of files a running program keeps writing
  to, either through a self-rotating `Writable` (`createRotatingStream`) or by
  watching files written by something else (`createArchiver`).
- Triggers: `size`, `age`, `every`, `daily`, `when`, combined with `any` / `all`.
- Compression: gzip, deflate, brotli and zstd, streamed, plus custom codecs.
- Retention by file count, age and total size, applied per source and matched
  strictly against the source's own filename template.
- Pluggable `ArchiveStore`, with a local filesystem implementation.
- `Source.nextDueAt()` and `Archiver.schedule()` for answering "when does this
  next roll?" from a monitoring endpoint.
- `onDetached` hook, fired the moment the contents leave the live file and
  awaited before compression starts — the right place to signal a writer to
  reopen, since the `archived` event does not fire until the archive is stored.
- `warning` event for problems that did not cost you the archive: a hook that
  threw, or a retention delete that failed.

### Safety

These are the guarantees the failure paths make, and the reasons they exist:

- **Contents are never destroyed to tidy up an error.** A failed run restores
  the live file where that is safe, and otherwise retains the bytes on disk,
  names them on `ArchiveFailedError.retained`, and lets the next run adopt them.
- **Archives are published atomically** via a staged `.part` file, so a crash
  cannot leave a truncated archive under a name that looks complete, and cannot
  fool retention into counting it.
- **`put` means durable**: the archive and its directory entry are flushed
  before it resolves, because the caller deletes its other copy immediately.
- **Permissions and ownership survive rotation**, so a private log stays private
  and a writer running as another user does not lose access to it.
- **Concurrent archivers are serialized** by a lock file with dead-owner
  detection, and cannot interleave rotations of the same file.
- **`daily()` and `every()` survive a restart** by recovering their anchor from
  the newest archive already stored.
- **A detach that fails before the live file has given up its bytes cleans up
  after itself**, so a half-written copy cannot be adopted by a later run and
  archived a second time. Duplicating an audit trail is as wrong as losing it.
- **Nothing in the recovery path throws**, so a failure there cannot mask the
  error that caused it.
