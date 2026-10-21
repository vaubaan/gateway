/**
 * Restore of a store copy (ADR restore-verifies-before-it-replaces-and-runs-at-first-boot):
 * the one implementation behind the `restore` command and the first-boot restore.
 *
 *   1. preflight: the store's directory exists; an existing, non-empty store needs
 *      `force`, and is refused while another connection holds it;
 *   2. acquire: the source (an absolute file, or an https URL followed by hand
 *      through at most five https redirects) is streamed into a temporary file of
 *      the store's directory, hashed on the way, cut at `maxBytes`;
 *   2b. an encrypted backup (ADR scheduled-encrypted-backup-to-object-storage, D9) — the
 *      SHA-256 is the encrypted object's — is opened with the instance's master key of
 *      the version its header names into a second temporary file, which the next steps
 *      read and install;
 *   3. verify, on the temporary copy: SHA-256 (when expected) first, then SQLite
 *      opens it read-only, `integrity_check` is `ok`, every recorded migration is
 *      one this image ships with the same checksum, every sealed blob opens with
 *      the encryptor (the instance's current and previous keys);
 *   4. install (unless `dryRun`): fsync, move aside what is in the way (never
 *      delete), rename onto `store.path`, fsync the directory.
 *
 * Every path computation and file call is marked `turbopackIgnore`: left alone,
 * Turbopack reads a computed path as dynamic filesystem access and traces the
 * whole application, tests included, into the standalone output (see
 * `packages/plugin-sdk/src/catalog-path.ts`).
 *
 * Failures are `RestoreError`s whose message never contains the URL: the caller
 * may print them, and a presigned URL is a credential.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { BackupCipherError, decryptBackupFile, isEncryptedBackupFile } from '../backup/cipher';
import type { RestoreSource } from '../config/restore-source';
import type { EncryptionKeys } from '../config/types';
import type { Encryptor } from '../crypto';
import {
  heldByAnotherConnection,
  integrityOf,
  MEMORY_PATH,
  openReadonlyDb,
  type StoreDb,
} from '../store/db';
import { compareWithShipped, loadMigrations, type Migration } from '../store/migrate';
import { openEverySealedBlobOf, type SealedOpenCount } from '../store/repositories/sealed-blobs';

/** How long a download may last, start to end (handbook configuration, "Fixed in code"). */
export const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
/** Redirects followed, each to an https URL. */
export const MAX_REDIRECTS = 5;

export type RestoreFailureKind =
  /** The source cannot be read: no such file, not a regular file, the store itself. */
  | 'source'
  /** The download failed: network, status, redirect, size cap, timeout. */
  | 'download'
  /** The copy is not the one expected or cannot serve this instance. */
  | 'verify'
  /** A non-empty store exists and `force` was not given. */
  | 'exists'
  /** `force` was given but another connection holds the store. */
  | 'in-use'
  /** `store.path` cannot receive a restore (`:memory:`, no directory). */
  | 'target';

export class RestoreError extends Error {
  constructor(
    readonly kind: RestoreFailureKind,
    message: string,
    /** What verification found before it refused, when it got that far. */
    readonly report?: VerificationReport,
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

export interface KeyVersionFinding {
  readonly keyVersion: number;
  readonly blobs: number;
  readonly unreadable: number;
  /** Whether this instance holds a key for that version (current or previous). */
  readonly configured: boolean;
}

export interface VerificationReport {
  readonly bytes: number;
  readonly sha256: string;
  readonly integrity: string;
  readonly schemaVersion: number;
  readonly shippedSchemaVersion: number;
  readonly keyVersions: readonly KeyVersionFinding[];
}

/** What an encrypted backup's header said (`null` for a plain store copy). */
export interface RestoreEncryption {
  /** The master key version the file was encrypted under. */
  readonly keyVersion: number;
  /** The versions its sealed secrets are under, as the backup named them. */
  readonly sealedKeyVersions: readonly number[];
}

export interface RestoreReport extends VerificationReport {
  /** The backup's encryption, when the source was an encrypted backup. */
  readonly encryption: RestoreEncryption | null;
  /** Whether the copy replaced `store.path` (false on a dry run). */
  readonly installed: boolean;
  /** What existed and was moved aside, as `<name>.replaced-<UTC timestamp>`. */
  readonly movedAside: readonly string[];
  /** Whether a non-empty store existed when the run started. */
  readonly storeExisted: boolean;
}

export interface RestoreOptions {
  readonly source: RestoreSource;
  /** Expected SHA-256 (lower-case hex); required for a URL. */
  readonly sha256: string | null;
  readonly maxBytes: number;
  readonly storePath: string;
  /** Opens the copy's blobs: the instance's current and previous keys. */
  readonly encryptor: Encryptor;
  /** The key versions this instance holds (current and previous). */
  readonly keyVersions: readonly number[];
  /**
   * The instance's master keys, to open an encrypted backup. Without them an encrypted
   * backup is refused (a plain copy needs only the encryptor).
   */
  readonly masterKeys?: EncryptionKeys;
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly migrations?: readonly Migration[];
  readonly downloadTimeoutMs?: number;
}

/** A store "exists" for the restore when its file is there and not empty. */
export function storeHasContent(path: string): boolean {
  if (path === MEMORY_PATH || !existsSync(/* turbopackIgnore: true */ path)) return false;
  try {
    return statSync(/* turbopackIgnore: true */ path).size > 0;
  } catch {
    return false;
  }
}

export async function restoreStore(options: RestoreOptions): Promise<RestoreReport> {
  const { storePath } = options;
  if (storePath === MEMORY_PATH) {
    throw new RestoreError('target', 'store.path is :memory:: there is no file to restore into');
  }
  const dir = dirname(resolve(/* turbopackIgnore: true */ storePath));
  if (
    !existsSync(/* turbopackIgnore: true */ dir) ||
    !statSync(/* turbopackIgnore: true */ dir).isDirectory()
  ) {
    throw new RestoreError('target', `the directory of store.path (${dir}) does not exist`);
  }
  if (options.source.kind === 'url' && options.sha256 === null) {
    throw new RestoreError('verify', 'an https source needs its expected SHA-256');
  }
  const storeExisted = storeHasContent(storePath);
  if (storeExisted && !options.dryRun) assertReplaceable(options);

  const stem = `.${basename(storePath)}.restore-${randomBytes(6).toString('hex')}`;
  const temp = join(/* turbopackIgnore: true */ dir, `${stem}.tmp`);
  const plainTemp = join(/* turbopackIgnore: true */ dir, `${stem}.plain.tmp`);
  try {
    const acquired = await acquire(options, temp);
    const { copy, encryption } = await openIfEncrypted(temp, plainTemp, options, acquired);
    const report = await verify(copy, options, acquired);
    if (options.dryRun) {
      return { ...report, encryption, installed: false, movedAside: [], storeExisted };
    }
    // The state may have changed during a long download: check again, then replace.
    if (storeHasContent(storePath)) assertReplaceable(options);
    const movedAside = install(copy, storePath, (options.now ?? (() => new Date()))());
    return { ...report, encryption, installed: true, movedAside, storeExisted };
  } finally {
    for (const file of [temp, plainTemp]) {
      for (const leftover of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
        rmSync(/* turbopackIgnore: true */ leftover, { force: true });
      }
    }
  }
}

/**
 * An encrypted backup is checked against its expected SHA-256 as it was downloaded,
 * then opened into `plainTemp`; a plain copy is read where it is.
 */
async function openIfEncrypted(
  temp: string,
  plainTemp: string,
  options: RestoreOptions,
  acquired: { readonly bytes: number; readonly sha256: string },
): Promise<{ copy: string; encryption: RestoreEncryption | null }> {
  if (!(await isEncryptedBackupFile(temp))) return { copy: temp, encryption: null };
  const partial: VerificationReport = {
    bytes: acquired.bytes,
    sha256: acquired.sha256,
    integrity: 'not checked',
    schemaVersion: 0,
    shippedSchemaVersion: 0,
    keyVersions: [],
  };
  if (options.sha256 !== null && options.sha256 !== acquired.sha256) {
    throw new RestoreError(
      'verify',
      `SHA-256 mismatch: expected ${options.sha256}, the copy is ${acquired.sha256}; nothing else was read`,
      partial,
    );
  }
  if (!options.masterKeys) {
    throw new RestoreError(
      'verify',
      'the copy is an encrypted backup and no master key was given to open it',
      partial,
    );
  }
  try {
    const header = await decryptBackupFile(temp, plainTemp, options.masterKeys);
    return {
      copy: plainTemp,
      encryption: { keyVersion: header.keyVersion, sealedKeyVersions: header.sealedKeyVersions },
    };
  } catch (err) {
    if (err instanceof BackupCipherError) throw new RestoreError('verify', err.message, partial);
    throw err;
  }
}

function assertReplaceable(options: RestoreOptions): void {
  if (!options.force) {
    throw new RestoreError(
      'exists',
      `a store exists at ${options.storePath}: nothing was replaced (--force replaces it, keeping it aside)`,
    );
  }
  if (heldByAnotherConnection(options.storePath)) {
    throw new RestoreError(
      'in-use',
      `the store at ${options.storePath} is open in another process (the gateway?): stop it first; nothing was replaced`,
    );
  }
}

/* ------------------------------------------------------------------------ */
/* Acquire                                                                   */
/* ------------------------------------------------------------------------ */

async function acquire(
  options: RestoreOptions,
  temp: string,
): Promise<{ bytes: number; sha256: string }> {
  const fd = openSync(/* turbopackIgnore: true */ temp, 'wx', 0o600);
  try {
    const chunks =
      options.source.kind === 'file'
        ? readLocal(options.source.path, options.storePath, options.maxBytes)
        : await download(options.source.url, options);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of chunks) {
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) {
        throw new RestoreError(
          options.source.kind === 'file' ? 'source' : 'download',
          `the copy is larger than the cap of ${options.maxBytes} bytes (restore.max_mb)`,
        );
      }
      hash.update(chunk);
      writeAll(fd, chunk);
    }
    fsyncSync(fd);
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.byteLength) {
    offset += writeSync(fd, chunk, offset, chunk.byteLength - offset);
  }
}

function readLocal(path: string, storePath: string, maxBytes: number): AsyncIterable<Uint8Array> {
  if (
    resolve(/* turbopackIgnore: true */ path) === resolve(/* turbopackIgnore: true */ storePath)
  ) {
    throw new RestoreError('source', 'the source is the store itself');
  }
  let stats;
  try {
    stats = statSync(/* turbopackIgnore: true */ path);
  } catch {
    throw new RestoreError('source', `no file at ${path}`);
  }
  if (!stats.isFile()) throw new RestoreError('source', `${path} is not a regular file`);
  if (stats.size > maxBytes) {
    throw new RestoreError(
      'source',
      `the copy is larger than the cap of ${maxBytes} bytes (restore.max_mb)`,
    );
  }
  return createReadStream(/* turbopackIgnore: true */ path);
}

async function download(url: URL, options: RestoreOptions): Promise<AsyncIterable<Uint8Array>> {
  const doFetch = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  let current = url;
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'https:') {
      throw new RestoreError('download', 'a redirect pointed to a URL that is not https: refused');
    }
    let res: Response;
    try {
      res = await doFetch(current, { redirect: 'manual', signal });
    } catch (err) {
      throw new RestoreError('download', `the download failed (${failureCode(err)})`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const location = res.headers.get('location');
      if (location === null || hop >= MAX_REDIRECTS) {
        throw new RestoreError(
          'download',
          location === null
            ? `the server answered ${res.status} without a Location`
            : `more than ${MAX_REDIRECTS} redirects`,
        );
      }
      try {
        current = new URL(location, current);
      } catch {
        throw new RestoreError('download', 'a redirect pointed to an invalid URL');
      }
      continue;
    }
    if (!res.ok || res.body === null) {
      await res.body?.cancel();
      throw new RestoreError('download', `the server answered ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await res.body.cancel();
      throw new RestoreError(
        'download',
        `the copy is larger than the cap of ${options.maxBytes} bytes (restore.max_mb)`,
      );
    }
    return guardStream(res.body);
  }
}

/** The body as an iterable whose errors never carry a message (it could quote the URL). */
async function* guardStream(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } catch (err) {
    if (err instanceof RestoreError) throw err;
    throw new RestoreError('download', `the download was cut (${failureCode(err)})`);
  } finally {
    // Stops the transfer when the consumer leaves early (the size cap).
    await reader.cancel().catch(() => undefined);
  }
}

/** A short, URL-free name for a network failure: an error code or class, never a message. */
function failureCode(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause;
  for (const candidate of [cause, err]) {
    const code = (candidate as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
  }
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  return err instanceof Error ? err.name : 'unknown';
}

/* ------------------------------------------------------------------------ */
/* Verify                                                                    */
/* ------------------------------------------------------------------------ */

async function verify(
  temp: string,
  options: RestoreOptions,
  copy: { readonly bytes: number; readonly sha256: string },
): Promise<VerificationReport> {
  // `bytes` and `sha256` are those of the source as acquired (for an encrypted
  // backup, the encrypted object), whichever file `temp` is.
  const partial: VerificationReport = {
    bytes: copy.bytes,
    sha256: copy.sha256,
    integrity: 'not checked',
    schemaVersion: 0,
    shippedSchemaVersion: 0,
    keyVersions: [],
  };
  if (options.sha256 !== null && options.sha256 !== copy.sha256) {
    throw new RestoreError(
      'verify',
      `SHA-256 mismatch: expected ${options.sha256}, the copy is ${copy.sha256}; nothing else was read`,
      partial,
    );
  }

  let db: StoreDb;
  try {
    db = openReadonlyDb(temp);
  } catch {
    throw new RestoreError('verify', 'the copy does not open as an SQLite database', partial);
  }
  try {
    let integrity: string;
    try {
      integrity = integrityOf(db);
    } catch {
      throw new RestoreError('verify', 'the copy is not an SQLite database', partial);
    }
    const withIntegrity = { ...partial, integrity };
    if (integrity !== 'ok') {
      throw new RestoreError('verify', `integrity_check failed: ${integrity}`, withIntegrity);
    }

    const shipped = compareWithShipped(db, options.migrations ?? loadMigrations());
    const withSchema = {
      ...withIntegrity,
      schemaVersion: shipped.version,
      shippedSchemaVersion: shipped.shippedVersion,
    };
    if (!shipped.hasMigrationsTable) {
      throw new RestoreError(
        'verify',
        'the copy is not a store of this gateway (no schema_migrations table)',
        withSchema,
      );
    }
    if (shipped.unknown.length > 0) {
      throw new RestoreError(
        'verify',
        `the copy is newer than this image: it records ${shipped.unknown.join(', ')}; ` +
          `this image ships up to ${shipped.shippedVersion}. Use an image at least as new as the one that wrote it`,
        withSchema,
      );
    }
    if (shipped.changed.length > 0) {
      throw new RestoreError(
        'verify',
        `the copy records migrations whose content differs from this image's: ${shipped.changed.join(', ')}`,
        withSchema,
      );
    }

    const opened = await openEverySealedBlobOf(db, options.encryptor);
    const keyVersions = summarize(opened, options.keyVersions);
    const full = { ...withSchema, keyVersions };
    const failing = keyVersions.filter((k) => k.unreadable > 0);
    if (failing.length > 0) {
      throw new RestoreError(
        'verify',
        "stored secrets of the copy do not open with this instance's keys: " +
          failing
            .map((k) =>
              k.configured
                ? `version ${k.keyVersion}: ${k.unreadable} of ${k.blobs} do not open with the key configured for it`
                : `version ${k.keyVersion}: no key configured (${k.blobs} blobs; add it to VAUBAAN_MASTER_KEY_PREVIOUS)`,
            )
            .join('; '),
        full,
      );
    }
    return full;
  } finally {
    db.close();
  }
}

function summarize(
  opened: readonly SealedOpenCount[],
  configured: readonly number[],
): KeyVersionFinding[] {
  const byVersion = new Map<number, { blobs: number; unreadable: number }>();
  for (const o of opened) {
    const entry = byVersion.get(o.keyVersion) ?? { blobs: 0, unreadable: 0 };
    entry.blobs += o.count;
    entry.unreadable += o.unreadable;
    byVersion.set(o.keyVersion, entry);
  }
  return [...byVersion.entries()]
    .sort(([a], [b]) => a - b)
    .map(([keyVersion, entry]) => ({
      keyVersion,
      ...entry,
      configured: configured.includes(keyVersion),
    }));
}

/* ------------------------------------------------------------------------ */
/* Install                                                                   */
/* ------------------------------------------------------------------------ */

/** Moves aside whatever is in the way (never deletes), renames the copy into place. */
function install(temp: string, storePath: string, now: Date): string[] {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const movedAside: string[] = [];
  for (const path of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
    if (!existsSync(/* turbopackIgnore: true */ path)) continue;
    const aside = `${path}.replaced-${stamp}`;
    renameSync(/* turbopackIgnore: true */ path, aside);
    movedAside.push(aside);
  }
  renameSync(/* turbopackIgnore: true */ temp, storePath);
  syncDirectory(dirname(resolve(/* turbopackIgnore: true */ storePath)));
  return movedAside;
}

function syncDirectory(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(/* turbopackIgnore: true */ dir, 'r');
    fsyncSync(fd);
  } catch {
    // Some file systems refuse to fsync a directory; the rename is done either way.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
