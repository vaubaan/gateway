/**
 * `import-v4`: the command the container runs to import a v4 bundle (ADR
 * import-from-v4-one-shot-importer D1, D4). Built into
 * `apps/gateway/import-v4.mjs` beside the standalone server
 * (`scripts/build-import-v4.mjs`).
 *
 *   <exporter> | node apps/gateway/import-v4.mjs --owner <email> [--apply] [--allow-stale]
 *
 * The bundle comes on stdin only: no file argument, no secret in argv. The
 * report goes to stderr; stdout carries nothing but the mission keys of an
 * `--apply`, one JSON object per line, so it can be piped on its own. The
 * instance's own configuration, master key and store are used — the command
 * refuses to run without them (checked before stdin is read), and refuses to
 * run as root. A bundle older than an hour is refused unless `--allow-stale`.
 *
 * Exit codes (sysexits): 0 done, 1 something the run tried was refused or an
 * unexpected failure, 64 usage, 65 invalid or stale bundle, 67 unknown owner,
 * 77 run as root, 78 the instance is not configured.
 */
import { existsSync } from 'node:fs';

import type { AuditEntry, AuditWriter } from '@vaubaan/gateway-core';

import { buildRoot, type GatewayRoot, type RootDeps } from '../compose/root';
import { openEmbeddedStore } from '../compose/store';
import { ConfigError, loadInstanceConfig, secretValues, type LoadedConfig } from '../config';
import { createRedactor } from '../logging';
import type { Store } from '../store';
import { MEMORY_PATH } from '../store/db';
import {
  bundleAgeMs,
  MAX_BUNDLE_AGE_MS,
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_CLOCK_SKEW_MS,
  parseBundle,
  secretsOf,
} from './bundle';
import { Importer, ImportRefused, type ImportReport, type MissionProvenance } from './importer';
import { renderReport } from './report';

export const EXIT_OK = 0;
export const EXIT_PARTIAL = 1;
export const EXIT_USAGE = 64;
export const EXIT_DATA = 65;
export const EXIT_NO_USER = 67;
export const EXIT_NO_PERMISSION = 77;
export const EXIT_CONFIG = 78;

/** The marker of every audit entry this command writes (`after.marker`). */
export const IMPORT_AUDIT_MARKER = 'imported-from-v4';

/** The one line printed for a failure nobody foresaw: never its message, never a stack. */
export const UNEXPECTED_FAILURE =
  'import-v4: unexpected failure (details withheld: they may quote a secret). What was written before it stays; run the import again.\n';

/** Most `mission-issued` entries of one owner the provenance lookup reads. */
const PROVENANCE_SCAN_LIMIT = 100_000;

export const USAGE = `Usage: node apps/gateway/import-v4.mjs --owner <email> [--apply] [--allow-stale] < bundle.json

Imports the bundle written by scripts/export-v4.mjs (read on stdin) into this
instance, under <email>, an active user who has signed in once.

  --owner <email>  the user every connection and mission is created for
  --apply          write; without it, print the plan and write nothing
  --allow-stale    accept a bundle exported more than an hour ago
  --help           this text

The report goes to stderr. With --apply, stdout carries the mission keys,
one JSON object per line: {"project","mission_id","token_name","key"}.
Handbook: docs/handbook/import-from-v4.md
`;

export interface CliIo {
  readonly stdin: AsyncIterable<Buffer | string> & { readonly isTTY?: boolean };
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** `process.getuid()`; `null` where the platform has none. */
  readonly uid: number | null;
}

export interface CliDeps {
  /** Root injections (tests: the `:memory:` store, a fixture registry, a mock provider). */
  readonly rootDeps?: Omit<RootDeps, 'logWrite'>;
  readonly loadConfig?: () => LoadedConfig;
  readonly storeExists?: (path: string) => boolean;
  /** The clock the bundle's age is read with (tests). */
  readonly now?: () => Date;
}

export interface CliArgs {
  readonly ownerEmail: string;
  readonly apply: boolean;
  readonly allowStale: boolean;
}

export type ParsedArgs =
  | { readonly kind: 'run'; readonly args: CliArgs }
  | { readonly kind: 'help' }
  | { readonly kind: 'usage'; readonly problem: string };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let ownerEmail: string | null = null;
  let apply = false;
  let allowStale = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--allow-stale') {
      allowStale = true;
      continue;
    }
    if (arg === '--owner') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { kind: 'usage', problem: '--owner needs an email' };
      }
      ownerEmail = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith('--owner=')) {
      ownerEmail = arg.slice('--owner='.length);
      continue;
    }
    // Never echo an unknown argument: it may be a secret pasted in the wrong place.
    return { kind: 'usage', problem: `unknown argument #${i + 1}` };
  }
  if (!ownerEmail || !ownerEmail.includes('@')) {
    return { kind: 'usage', problem: '--owner <email> is required' };
  }
  return { kind: 'run', args: { ownerEmail, apply, allowStale } };
}

async function readAll(
  stdin: CliIo['stdin'],
  limit: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += buffer.length;
    if (size > limit) return { ok: false };
    chunks.push(buffer);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * The audit side of an import. `wrap` marks every administrative entry the
 * services write during the run (connection created, resource edited,
 * mission issued) with `marker` and `v4_org`, and — inside `during` — with
 * `v4_source`, the v4 token a mission comes from. `issued` reads those
 * `mission-issued` entries back: that is how a later run recognises a mission
 * it issued, by provenance and never by name.
 */
export function createImportMarker(org: string): {
  wrap(store: Store): Store;
  provenance(store: Pick<Store, 'audit'>): MissionProvenance;
} {
  let source: string | null = null;
  return {
    wrap(store) {
      const inner = store.auditWriter;
      const auditWriter: AuditWriter = {
        async write(entry: AuditEntry) {
          if (entry.kind !== 'admin') return inner.write(entry);
          const after =
            typeof entry.after === 'object' && entry.after !== null && !Array.isArray(entry.after)
              ? (entry.after as Record<string, unknown>)
              : { value: entry.after };
          return inner.write({
            ...entry,
            after: {
              ...after,
              marker: IMPORT_AUDIT_MARKER,
              v4_org: org,
              ...(source !== null ? { v4_source: source } : {}),
            },
          });
        },
      };
      return { ...store, auditWriter };
    },
    provenance(store) {
      return {
        async issued(ownerId) {
          const entries = await store.audit.list({
            kind: 'admin',
            act: 'mission-issued',
            userId: ownerId,
            limit: PROVENANCE_SCAN_LIMIT,
          });
          const issued = new Map<string, string>();
          for (const entry of entries) {
            if (entry.kind !== 'admin') continue;
            const after = entry.after as Record<string, unknown> | null;
            if (
              after?.marker === IMPORT_AUDIT_MARKER &&
              after.v4_org === org &&
              typeof after.v4_source === 'string'
            ) {
              issued.set(after.v4_source, entry.object.id);
            }
          }
          return issued;
        },
        async during(next, act) {
          source = next;
          try {
            return await act();
          } finally {
            source = null;
          }
        },
      };
    },
  };
}

export async function runImportCli(
  argv: readonly string[],
  io: CliIo,
  deps: CliDeps = {},
): Promise<number> {
  try {
    return await run(argv, io, deps);
  } catch {
    io.stderr(UNEXPECTED_FAILURE);
    return EXIT_PARTIAL;
  }
}

async function run(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    io.stderr(USAGE);
    return EXIT_OK;
  }
  if (parsed.kind === 'usage') {
    io.stderr(`import-v4: ${parsed.problem}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (io.uid === 0) {
    io.stderr(
      'import-v4: refusing to run as root. Run it as the image user: `docker compose exec -T gateway node …` ' +
        'does; on a platform that starts the container as root, prefix the command with `vaubaan-entrypoint`, ' +
        'which drops to it.\n',
    );
    return EXIT_NO_PERMISSION;
  }
  if (io.stdin.isTTY) {
    io.stderr('import-v4: the bundle is read on stdin: pipe the exporter into this command.\n');
    return EXIT_USAGE;
  }

  // The instance first: a misconfigured container never reads the secrets at all.
  let loaded: LoadedConfig;
  try {
    loaded = (deps.loadConfig ?? loadInstanceConfig)();
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr(`import-v4: this instance is not configured:\n${err.message}\n`);
      return EXIT_CONFIG;
    }
    throw err;
  }
  const storePath = loaded.config.store.path;
  const storeExists = deps.storeExists ?? existsSync;
  if (storePath === MEMORY_PATH || !storeExists(storePath)) {
    io.stderr(
      `import-v4: no store at '${storePath}' (store.path): run this command inside the instance's container, ` +
        'where its volume is mounted, after the instance has started once.\n',
    );
    return EXIT_CONFIG;
  }

  const read = await readAll(io.stdin, MAX_BUNDLE_BYTES);
  if (!read.ok) {
    io.stderr(`import-v4: the bundle is larger than ${MAX_BUNDLE_BYTES} bytes.\n`);
    return EXIT_DATA;
  }
  const bundle = parseBundle(read.text);
  if (!bundle.ok) {
    io.stderr(
      `import-v4: the bundle is refused, nothing was written:\n${bundle.problems.map((p) => `  - ${p}\n`).join('')}`,
    );
    return EXIT_DATA;
  }
  const ageMs = bundleAgeMs(bundle.bundle, (deps.now ?? (() => new Date()))());
  const minutes = Math.round(ageMs / 60_000);
  if (ageMs < -MAX_BUNDLE_CLOCK_SKEW_MS) {
    io.stderr('import-v4: the bundle claims to be exported in the future; nothing was written.\n');
    return EXIT_DATA;
  }
  if (ageMs > MAX_BUNDLE_AGE_MS && !parsed.args.allowStale) {
    io.stderr(
      `import-v4: the bundle was exported ${minutes} minutes ago (more than ${MAX_BUNDLE_AGE_MS / 60_000}): ` +
        'v4 may have revoked keys or tokens since. Export again and pipe it straight in, or pass --allow-stale. ' +
        'Nothing was written.\n',
    );
    return EXIT_DATA;
  }
  const redact = createRedactor(secretsOf(bundle.bundle));

  const logRedact = createRedactor([...secretsOf(bundle.bundle), ...secretValues(loaded.config)]);
  const marker = createImportMarker(bundle.bundle.organization.slug);
  const openStore = deps.rootDeps?.openStore ?? openEmbeddedStore;
  let root: GatewayRoot;
  try {
    root = await buildRoot({
      ...deps.rootDeps,
      loadConfig: () => loaded,
      openStore: async (ctx) => marker.wrap(await openStore(ctx)),
      // The gateway's own log lines: errors only (its boot warnings are about serving,
      // which this command does not do), on stderr, secrets blanked. Every refusal the
      // import meets is in its report.
      logWrite: (level, line) => {
        if (level === 'error') io.stderr(logRedact(line));
      },
    });
  } catch (err) {
    io.stderr(`import-v4: the instance could not be opened: ${redact(errorText(err))}\n`);
    return EXIT_CONFIG;
  }

  try {
    const report = await new Importer({
      registry: root.registry,
      store: root.store,
      connections: root.connections.service,
      missions: root.missions.service,
      provenance: marker.provenance(root.store),
    }).run(bundle.bundle, parsed.args);
    io.stderr(`import-v4: bundle exported ${Math.max(minutes, 0)} minute(s) ago.\n`);
    io.stderr(redact(renderReport(report)));
    printKeys(report, io);
    return report.failed ? EXIT_PARTIAL : EXIT_OK;
  } catch (err) {
    if (err instanceof ImportRefused) {
      io.stderr(`import-v4: ${err.message}. Nothing was written.\n`);
      return EXIT_NO_USER;
    }
    io.stderr(UNEXPECTED_FAILURE);
    return EXIT_PARTIAL;
  } finally {
    try {
      await root.close();
    } catch {
      io.stderr('import-v4: the store did not close cleanly (details withheld).\n');
    }
  }
}

/** The mission keys, once, on stdout only: never in the report, the logs or the audit. */
function printKeys(report: ImportReport, io: CliIo): void {
  for (const key of report.keys) io.stdout(`${JSON.stringify(key)}\n`);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
