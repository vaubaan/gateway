/**
 * `backup`: a consistent copy of the instance's store, made inside the container
 * (re-check H-1 of fix/v5-sec-2). Built into `apps/gateway/backup.mjs` beside the
 * standalone server (`scripts/build-commands.mjs`); the image has no `sqlite3`.
 *
 *   node apps/gateway/backup.mjs [<file name>]
 *
 * Reads `store.path` from the instance's configuration, opens the database
 * read-only (no migration, no pragma written) and runs `VACUUM INTO` a file in the
 * same directory (the data volume): `backup-<UTC timestamp>.sqlite` by default, or
 * the plain file name given. It never overwrites a file, never writes outside that
 * directory, refuses root. It prints the path, the size, `PRAGMA integrity_check` of
 * the copy, its schema version and the master-key versions its blobs are sealed
 * under: the copy opens only with the keys of those versions, as they are now.
 *
 * Before checking it, it writes into the copy (never into the live store) the
 * sign-in providers the configuration sets, as store-held ones, client secrets
 * sealed under the master key (ADR backup-carries-the-sign-in-configuration):
 * restored elsewhere, the copy signs people in as this instance does. The
 * administrators need no carrying: they are rows of the store (ADR
 * administrators-live-in-the-instance). It prints the ids it carried, never a secret.
 *
 * Exit codes (sysexits): 0 done, 1 the copy failed its integrity check or an
 * unexpected failure, 64 usage, 73 the file exists, 77 run as root, 78 not configured.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { ConfigError, loadProcessConfig, type LoadedConfig } from '../config';
import { createEncryptor } from '../crypto';
import { backupTo, MEMORY_PATH, openReadonlyDb } from '../store/db';
import { CopyWriteError, writeStoreCopy, type StoreCopy } from './copy';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 64;
export const EXIT_CANNOT_CREATE = 73;
export const EXIT_NO_PERMISSION = 77;
export const EXIT_CONFIG = 78;

export const UNEXPECTED_FAILURE =
  'backup: unexpected failure (details withheld). The store was only read; remove a partial copy if one was left, and run again.\n';

export const USAGE = `Usage: node apps/gateway/backup.mjs [<file name>]

Writes a consistent copy of this instance's store (VACUUM INTO) next to it, on
the data volume: backup-<UTC timestamp>.sqlite, or the plain file name given
(no directory). Never overwrites a file. The copy also carries the sign-in
providers the configuration sets, their client secrets sealed under the
master key, so that it signs people in once restored elsewhere; its
administrators are in the store it copies. Prints the path, the size, the integrity check and the master-key
versions the copy's secrets are sealed under: it opens only with those keys.
Download it, and keep those keys with it.

  --help    this text

Handbook: docs/handbook/store.md, "Backup"
`;

export interface BackupIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly uid: number | null;
}

export interface BackupDeps {
  readonly loadConfig?: () => LoadedConfig;
  readonly now?: () => Date;
}

/** A plain file name: no directory part, no hidden file, `.sqlite`/`.db` or none. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function defaultBackupName(now: Date): string {
  return `backup-${now.toISOString().replace(/[:.]/g, '-')}.sqlite`;
}

export async function runBackupCli(
  argv: readonly string[],
  io: BackupIo,
  deps: BackupDeps = {},
): Promise<number> {
  try {
    return await run(argv, io, deps);
  } catch {
    io.stderr(UNEXPECTED_FAILURE);
    return EXIT_FAILED;
  }
}

async function run(argv: readonly string[], io: BackupIo, deps: BackupDeps): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stderr(USAGE);
    return EXIT_OK;
  }
  if (argv.length > 1 || (argv[0] !== undefined && !FILE_NAME.test(argv[0]))) {
    io.stderr(
      `backup: the only argument is a plain file name (letters, digits, . _ -)\n\n${USAGE}`,
    );
    return EXIT_USAGE;
  }
  if (io.uid === 0) {
    io.stderr(
      'backup: refusing to run as root (the copy would belong to root). Prefix the command with ' +
        '`vaubaan-entrypoint`, which drops to the image user.\n',
    );
    return EXIT_NO_PERMISSION;
  }
  let loaded: LoadedConfig;
  try {
    loaded = (deps.loadConfig ?? loadProcessConfig)();
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr(`backup: this instance is not configured:\n${err.message}\n`);
      return EXIT_CONFIG;
    }
    throw err;
  }
  const storePath = loaded.config.store.path;
  if (storePath === MEMORY_PATH || !existsSync(storePath)) {
    io.stderr(
      `backup: no store at '${storePath}' (store.path): run this command inside the instance's container.\n`,
    );
    return EXIT_CONFIG;
  }
  const name = argv[0] ?? defaultBackupName((deps.now ?? (() => new Date()))());
  const target = join(dirname(storePath), basename(name));
  if (existsSync(target)) {
    io.stderr(`backup: '${target}' exists; nothing was written. Choose another name.\n`);
    return EXIT_CANNOT_CREATE;
  }

  let copy: StoreCopy;
  try {
    copy = await writeStoreCopy({
      vacuumInto: (to) => {
        const source = openReadonlyDb(storePath);
        try {
          backupTo(source, to);
        } finally {
          source.close();
        }
      },
      target,
      config: loaded.config,
      encryptor: await createEncryptor(loaded.config.encryption),
      now: deps.now,
    });
  } catch (err) {
    if (!(err instanceof CopyWriteError)) throw err;
    io.stderr(
      'backup: the sign-in configuration could not be written into the copy (details withheld); the copy was removed. The store was only read.\n',
    );
    return EXIT_FAILED;
  }
  const versions = copy.sealedKeyVersions;
  io.stdout(
    [
      `backup: ${target}`,
      `backup: ${copy.bytes} bytes, schema version ${copy.schemaVersion}, integrity_check: ${copy.integrity}`,
      versions.length === 0
        ? 'backup: it holds no sealed secret.'
        : `backup: its secrets are sealed under master key version(s) ${versions.join(', ')}: ` +
          'the copy opens only with the keys of those versions as they are now. Keep them with it.',
      copy.carried.length === 0
        ? 'backup: no sign-in provider is set by the configuration; the copy holds the providers and administrators of the store.'
        : `backup: it carries the sign-in provider(s) the configuration sets (${copy.carried.join(', ')}) ` +
          'as providers kept in the store, their client secrets sealed; the administrators are in the store.',
      'backup: copy it off the volume (deploy/railway.md §6), then delete it from the volume.',
    ].join('\n') + '\n',
  );
  return copy.integrity === 'ok' ? EXIT_OK : EXIT_FAILED;
}
