/**
 * `restore`: puts a store copy in place of the instance's store, after proving it
 * is the copy meant and that this instance can use it (ADR
 * restore-verifies-before-it-replaces-and-runs-at-first-boot). Built into
 * `apps/gateway/restore.mjs` beside the standalone server (`scripts/build-commands.mjs`).
 *
 *   node apps/gateway/restore.mjs [<source>] [--sha256 <hex>] [--dry-run] [--force] [--max-mb <n>]
 *
 * The source is an absolute file path or an https URL; without one, the configured
 * `restore.from` (`VAUBAAN_RESTORE_FROM`) and `restore.sha256` are used. Refuses root.
 *
 * Exit codes (sysexits): 0 done (or the dry run passed), 1 unexpected failure,
 * 64 usage, 65 the copy failed a check, 66 the source cannot be read, 69 the
 * download failed, 73 a store exists (no `--force`), 75 the store is in use,
 * 77 run as root, 78 not configured.
 */
import { ConfigError, loadProcessConfig, type LoadedConfig } from '../config';
import {
  describeRestoreSource,
  parseRestoreSource,
  parseSha256,
  type RestoreSource,
} from '../config/restore-source';
import { createEncryptor, type Encryptor } from '../crypto';
import {
  RestoreError,
  restoreStore,
  type RestoreFailureKind,
  type RestoreReport,
  type VerificationReport,
} from './restore';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 64;
export const EXIT_DATA = 65;
export const EXIT_NO_INPUT = 66;
export const EXIT_UNAVAILABLE = 69;
export const EXIT_CANNOT_CREATE = 73;
export const EXIT_IN_USE = 75;
export const EXIT_NO_PERMISSION = 77;
export const EXIT_CONFIG = 78;

const EXIT_OF: Record<RestoreFailureKind, number> = {
  source: EXIT_NO_INPUT,
  download: EXIT_UNAVAILABLE,
  verify: EXIT_DATA,
  exists: EXIT_CANNOT_CREATE,
  'in-use': EXIT_IN_USE,
  target: EXIT_CONFIG,
};

export const UNEXPECTED_FAILURE =
  'restore: unexpected failure (details withheld: they may quote a secret). The store was not replaced unless the command said so; run again.\n';

const BYTES_PER_MEGABYTE = 1024 * 1024;

export const USAGE = `Usage: node apps/gateway/restore.mjs [<source>] [options]

Replaces this instance's store with a copy made by backup.mjs, after checking
it: its SHA-256, SQLite's integrity check, a schema this image can migrate
(an older one is fine, a newer one is refused), and that every stored secret
opens with this instance's master keys (VAUBAAN_MASTER_KEY and
VAUBAAN_MASTER_KEY_PREVIOUS). Writes only beside store.path.

  <source>          an absolute file path, or an https URL (a URL needs
                    --sha256). Without it: VAUBAAN_RESTORE_FROM and
                    VAUBAAN_RESTORE_SHA256, which keep the URL out of the
                    shell history.
  --sha256 <hex>    the expected SHA-256 of the copy (64 hex characters)
  --dry-run         check everything, replace nothing
  --force           replace a store that exists (the gateway must be
                    stopped); the old one is kept as <name>.replaced-<time>
  --max-mb <n>      the largest copy accepted (default: restore.max_mb)
  --help            this text

Handbook: docs/handbook/store.md, "Restore"
`;

export interface RestoreIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly uid: number | null;
}

export interface RestoreDeps {
  readonly loadConfig?: () => LoadedConfig;
  readonly encryptor?: (loaded: LoadedConfig) => Promise<Encryptor>;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export interface RestoreArgs {
  readonly source: string | null;
  readonly sha256: string | null;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly maxMb: number | null;
}

export type ParsedRestoreArgs =
  | ({ readonly kind: 'run' } & RestoreArgs)
  | { readonly kind: 'help' }
  | { readonly kind: 'usage'; readonly problem: string };

/** Values are never echoed: a source may be a presigned URL pasted in the wrong place. */
export function parseRestoreArgs(argv: readonly string[]): ParsedRestoreArgs {
  let source: string | null = null;
  let sha256: string | null = null;
  let maxMb: number | null = null;
  let dryRun = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] =
      arg.startsWith('--') && arg.includes('=')
        ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
        : [arg, undefined];
    const value = (): string | undefined => inline ?? argv[++i];
    switch (flag) {
      case '--help':
      case '-h':
        return { kind: 'help' };
      case '--dry-run':
        dryRun = true;
        continue;
      case '--force':
        force = true;
        continue;
      case '--sha256': {
        const parsed = parseSha256(value() ?? '');
        if (parsed === null)
          return { kind: 'usage', problem: '--sha256 expects 64 hexadecimal characters' };
        sha256 = parsed;
        continue;
      }
      case '--max-mb': {
        const n = Number(value() ?? '');
        if (!Number.isInteger(n) || n < 1) {
          return { kind: 'usage', problem: '--max-mb expects an integer >= 1' };
        }
        maxMb = n;
        continue;
      }
      default:
        if (arg.startsWith('-') || source !== null) {
          return { kind: 'usage', problem: `unexpected argument #${i + 1}` };
        }
        source = arg;
    }
  }
  return { kind: 'run', source, sha256, dryRun, force, maxMb };
}

export async function runRestoreCli(
  argv: readonly string[],
  io: RestoreIo,
  deps: RestoreDeps = {},
): Promise<number> {
  try {
    return await run(argv, io, deps);
  } catch {
    io.stderr(UNEXPECTED_FAILURE);
    return EXIT_FAILED;
  }
}

async function run(argv: readonly string[], io: RestoreIo, deps: RestoreDeps): Promise<number> {
  const args = parseRestoreArgs(argv);
  if (args.kind === 'help') {
    io.stderr(USAGE);
    return EXIT_OK;
  }
  if (args.kind === 'usage') {
    io.stderr(`restore: ${args.problem}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (io.uid === 0) {
    io.stderr(
      'restore: refusing to run as root (the store would belong to root). Prefix the command with ' +
        '`vaubaan-entrypoint`, which drops to the image user.\n',
    );
    return EXIT_NO_PERMISSION;
  }
  let loaded: LoadedConfig;
  try {
    loaded = (deps.loadConfig ?? loadProcessConfig)();
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr(`restore: this instance is not configured:\n${err.message}\n`);
      return EXIT_CONFIG;
    }
    throw err;
  }
  const { config } = loaded;

  let source: RestoreSource;
  let sha256: string | null = args.sha256;
  if (args.source !== null) {
    const parsed = parseRestoreSource(args.source);
    if (!parsed.ok) {
      io.stderr(`restore: the source ${parsed.problem}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    source = parsed.source;
  } else if (config.restore.from !== null) {
    source = config.restore.from;
    sha256 ??= config.restore.sha256;
  } else {
    io.stderr(
      `restore: no source: give a file path or an https URL, or set VAUBAAN_RESTORE_FROM\n\n${USAGE}`,
    );
    return EXIT_USAGE;
  }
  if (source.kind === 'url' && sha256 === null) {
    io.stderr('restore: an https source needs --sha256 (or VAUBAAN_RESTORE_SHA256)\n');
    return EXIT_USAGE;
  }
  const maxBytes = args.maxMb !== null ? args.maxMb * BYTES_PER_MEGABYTE : config.restore.maxBytes;

  const encryptor = await (deps.encryptor ?? ((l) => createEncryptor(l.config.encryption)))(loaded);
  io.stdout(
    `restore: ${args.dryRun ? 'dry run: ' : ''}from ${describeRestoreSource(source)} into ${config.store.path}\n`,
  );
  try {
    const report = await restoreStore({
      source,
      sha256,
      maxBytes,
      storePath: config.store.path,
      encryptor,
      keyVersions: [config.encryption.keyVersion, ...config.encryption.previousKeys.keys()],
      masterKeys: config.encryption,
      force: args.force,
      dryRun: args.dryRun,
      fetch: deps.fetch,
      now: deps.now,
    });
    io.stdout(renderReport(report, sha256 !== null));
    return EXIT_OK;
  } catch (err) {
    if (!(err instanceof RestoreError)) throw err;
    if (err.report) io.stdout(renderFindings(err.report, sha256 !== null));
    io.stderr(`restore: refused: ${err.message}\n`);
    return EXIT_OF[err.kind];
  }
}

function renderFindings(report: VerificationReport, hashExpected: boolean): string {
  const lines = [
    `restore: ${report.bytes} bytes, sha256 ${report.sha256}${hashExpected ? '' : ' (no expected hash given)'}`,
  ];
  if (report.integrity !== 'not checked') {
    lines.push(
      `restore: integrity_check: ${report.integrity}, schema version ${report.schemaVersion} (this image: ${report.shippedSchemaVersion})`,
    );
  }
  if (report.keyVersions.length > 0) {
    for (const k of report.keyVersions) {
      lines.push(
        `restore: master key version ${k.keyVersion}: ${k.blobs} sealed secret(s), ` +
          `${k.configured ? 'key configured' : 'NO key configured'}, ${k.blobs - k.unreadable} open(s)`,
      );
    }
  } else if (report.integrity === 'ok' && report.schemaVersion > 0) {
    lines.push('restore: the copy holds no sealed secret.');
  }
  return lines.join('\n') + '\n';
}

function renderReport(report: RestoreReport, hashExpected: boolean): string {
  const lines = [renderFindings(report, hashExpected).trimEnd()];
  if (report.encryption) {
    lines.push(
      `restore: an encrypted backup (format ${report.encryption.format}${
        report.encryption.storeBytes === null
          ? ''
          : `, compressed, a store of ${report.encryption.storeBytes} bytes`
      }), opened with master key version ${report.encryption.keyVersion}`,
    );
  }
  if (!report.installed) {
    lines.push(
      report.storeExisted
        ? 'restore: dry run: every check passed; a store exists, a real run needs --force (gateway stopped).'
        : 'restore: dry run: every check passed; nothing was written.',
    );
  } else {
    for (const aside of report.movedAside) lines.push(`restore: kept aside: ${aside}`);
    lines.push(
      'restore: the store is in place. Start the gateway: the migrations run at boot. ' +
        'If its secrets are sealed under another instance\'s key, reseal (deploy/railway.md, "Moving an instance").',
    );
  }
  return lines.join('\n') + '\n';
}
