/** Error types thrown by archiverjs. */

/** Base class for every error the library throws deliberately. */
export class ArchiverError extends Error {
  /** Stable, machine-readable discriminator. */
  readonly code: string;

  constructor(message: string, code = 'ERR_ARCHIVER', options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Invalid configuration — thrown eagerly, at construction time. */
export class ArchiverConfigError extends ArchiverError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'ERR_ARCHIVER_CONFIG', options);
  }
}

/** A codec was requested that this Node build cannot provide (e.g. zstd before Node 22.15). */
export class CompressionUnavailableError extends ArchiverError {
  constructor(method: string) {
    super(
      `compression method '${method}' is not available in this Node.js runtime (${process.version})`,
      'ERR_ARCHIVER_COMPRESSION_UNAVAILABLE',
    );
  }
}

/** Another process holds the lock for this source. Not a failure — just not now. */
export class SourceLockedError extends ArchiverError {
  readonly path: string;

  constructor(path: string) {
    super(`another process is archiving '${path}'`, 'ERR_ARCHIVER_LOCKED');
    this.path = path;
  }
}

/** An archival run failed. The underlying failure is attached as `cause`. */
export class ArchiveFailedError extends ArchiverError {
  /** The source file the run was working on. */
  readonly path: string;
  /**
   * Where the detached contents were left, when they could not be put back.
   *
   * Data is never thrown away to make an error tidy: if a run dies after the
   * bytes have left the live file and restoring them is not safe, they stay on
   * disk under this path and the next successful run picks them up.
   */
  readonly retained: string | null;

  constructor(path: string, cause: unknown, retained: string | null = null) {
    const where = retained === null ? '' : ` (contents preserved at '${retained}')`;
    super(`failed to archive '${path}': ${describe(cause)}${where}`, 'ERR_ARCHIVE_FAILED', {
      cause,
    });
    this.path = path;
    this.retained = retained;
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
