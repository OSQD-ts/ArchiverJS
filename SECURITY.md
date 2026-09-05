# Security policy

## Reporting a vulnerability

Please report security issues privately, via GitHub's ["Report a
vulnerability"](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
form on this repository, rather than in a public issue.

Include a description, the affected version, and a reproduction if you have one.
Expect an acknowledgement within three working days.

## Supported versions

Until 1.0, only the latest minor release receives security fixes.

## Threat model

This library runs with write access to log directories, often as a privileged
user, and moves file contents around on behalf of a process that keeps writing.
The design follows from that:

| Concern | Mitigation |
| --- | --- |
| Disclosure through archive permissions | Archives inherit the source file's mode, so a `0600` log cannot become a `0644` archive. The staging file is created with the final mode, so the contents are never briefly world-readable. |
| Disclosure through the recreated log | After a `rename` rotation the replacement file is `chmod`ed explicitly, because `open`'s mode argument is filtered by the umask and would otherwise widen or narrow it silently. |
| Ownership escalation | When running as root the replacement is `chown`ed back to the original owner, so a rotation cannot quietly hand a `www-data` log to root — or lock the writer out of it. |
| Path traversal via filename templates | A rendered archive name is flattened to a single path segment; `.` and `..` are rejected. A template cannot write outside its destination, whatever a function template returns. |
| Destruction of data by a failed run | Contents that have left the live file are never deleted to tidy up an error. They are restored where safe, and otherwise retained on disk with the path reported on the error, then adopted by the next run. |
| Corruption by a second archiver | Each run holds a lock file next to the source. Without it, concurrent `copy-truncate` rotations duplicate hundreds of log lines — see `test/concurrency.test.ts`, which measures exactly that. |
| A crash leaving plausible-looking rubbish | Archives are staged and renamed into place, so a partial file is never published under a name that looks complete, and is never counted by retention. |
| Loss on power failure | The archive and its directory entry are flushed before `put` resolves, because the caller deletes its only other copy immediately afterwards. |
| Unbounded memory from a hostile writer | The copy-truncate drain reads through one fixed 64 KiB buffer, so a writer appending gigabytes during a rotation cannot exhaust the heap. |
| Supply chain | No runtime dependencies. CI fails if any appear. |

## What this library does not defend against

- **A source path an attacker controls.** Point it at a log directory you own.
- **A writer that never reopens, under the `rename` strategy.** Its writes go to the moved-away
  inode and are lost once that file is archived and removed. This is inherent to rename-based
  rotation, is what `copy-truncate` exists for, and is documented in the README.
- **Archive contents.** Rotating a file does not sanitize what a writer put in
  it; if your logs contain secrets, they are still in the archives.
- **Other processes with write access to the archive directory.** Retention
  deletes files matching the source's own naming template, so it will not touch
  unrelated files — but nothing stops someone else from deleting them.
