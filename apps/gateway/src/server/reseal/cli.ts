/**
 * `reseal`: the command the container runs after a master-key rotation (ADR
 * master-key-rotation-reseals-every-blob). Built into `apps/gateway/reseal.mjs`
 * beside the standalone server (`scripts/build-commands.mjs`).
 *
 *   node apps/gateway/reseal.mjs [--apply]
 *
 * Opens the instance's own store with its own configuration: the current
 * `VAUBAAN_MASTER_KEY` (and `VAUBAAN_MASTER_KEY_VERSION`) and the previous keys
 * of `VAUBAAN_MASTER_KEY_PREVIOUS`. Every blob sealed under another version is
 * opened with that version's key and sealed again under the current one. A dry
 * run by default: without `--apply` every blob is opened (so the report proves
 * the keys fit) and nothing is written. Idempotent: a second run finds nothing
 * to do. The report counts blobs, never shows one; it ends by saying whether
 * the previous keys can now be removed.
 *
 * Exit codes (sysexits): 0 done (or nothing to do), 1 some blob did not open
 * or changed under the run, 64 usage, 77 run as root, 78 the instance is not
 * configured.
 */
import { existsSync } from 'node:fs';

import { SHIPPED_PLUGINS } from '../compose/shipped-plugins';
import { DeferredCatalogIndex, KeptCatalogIndex, RegistryCatalogIndex } from '../compose/registry';
import { openEmbeddedStore, type StoreContext } from '../compose/store';
import { ConfigError, loadProcessConfig, secretValues, type LoadedConfig } from '../config';
import { createEncryptor, type Encryptor } from '../crypto';
import { createLogger, createRedactor } from '../logging';
import { loadPlugins } from '../plugins';
import type { CatalogIndex, Store } from '../store';
import { MEMORY_PATH } from '../store/db';
import { renderReseal } from './report';

export const EXIT_OK = 0;
export const EXIT_INCOMPLETE = 1;
export const EXIT_USAGE = 64;
export const EXIT_NO_PERMISSION = 77;
export const EXIT_CONFIG = 78;

/** The one line printed for a failure nobody foresaw: never its message, never a stack. */
export const UNEXPECTED_FAILURE =
  'reseal: unexpected failure (details withheld: they may quote a secret). A table already written stays written; run the command again.\n';

export const USAGE = `Usage: node apps/gateway/reseal.mjs [--apply]

Seals every stored secret (account credentials, configuration secrets,
approval arguments) again under the current master key, opening each with the
key of the version that sealed it (VAUBAAN_MASTER_KEY_PREVIOUS).

  --apply   write; without it, open every blob, report, and write nothing
  --help    this text

Handbook: docs/handbook/configuration.md, "Rotating the master key"
`;

export interface ResealIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** `process.getuid()`; `null` where the platform has none. */
  readonly uid: number | null;
}

export interface ResealDeps {
  readonly loadConfig?: () => LoadedConfig;
  readonly storeExists?: (path: string) => boolean;
  /** Tests: the `:memory:` store, seeded. */
  readonly openStore?: (ctx: StoreContext) => Promise<Store>;
  /** Tests: a catalog without the plugins of the instance. */
  readonly catalog?: () => Promise<CatalogIndex>;
  /** Tests: the encryptor the store is opened with. */
  readonly encryptor?: (loaded: LoadedConfig) => Promise<Encryptor>;
}

export type ParsedResealArgs =
  | { readonly kind: 'run'; readonly apply: boolean }
  | { readonly kind: 'help' }
  | { readonly kind: 'usage'; readonly problem: string };

export function parseResealArgs(argv: readonly string[]): ParsedResealArgs {
  let apply = false;
  for (const [i, arg] of argv.entries()) {
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    // Never echo an unknown argument: it may be a key pasted in the wrong place.
    return { kind: 'usage', problem: `unknown argument #${i + 1}` };
  }
  return { kind: 'run', apply };
}

export async function runResealCli(
  argv: readonly string[],
  io: ResealIo,
  deps: ResealDeps = {},
): Promise<number> {
  try {
    return await run(argv, io, deps);
  } catch {
    // expected: any other failure ends as UNEXPECTED_FAILURE; its message is withheld (it may quote a secret)
    io.stderr(UNEXPECTED_FAILURE);
    return EXIT_INCOMPLETE;
  }
}

async function run(argv: readonly string[], io: ResealIo, deps: ResealDeps): Promise<number> {
  const parsed = parseResealArgs(argv);
  if (parsed.kind === 'help') {
    io.stderr(USAGE);
    return EXIT_OK;
  }
  if (parsed.kind === 'usage') {
    io.stderr(`reseal: ${parsed.problem}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (io.uid === 0) {
    io.stderr(
      'reseal: refusing to run as root (the files it writes would belong to root). ' +
        'Prefix the command with `vaubaan-entrypoint`, which drops to the image user.\n',
    );
    return EXIT_NO_PERMISSION;
  }

  let loaded: LoadedConfig;
  try {
    loaded = (deps.loadConfig ?? loadProcessConfig)();
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr(`reseal: this instance is not configured:\n${err.message}\n`);
      return EXIT_CONFIG;
    }
    throw err;
  }
  const { config } = loaded;
  const storePath = config.store.path;
  if (storePath === MEMORY_PATH || !(deps.storeExists ?? existsSync)(storePath)) {
    io.stderr(
      `reseal: no store at '${storePath}' (store.path): run this command inside the instance's container, ` +
        'where its volume is mounted.\n',
    );
    return EXIT_CONFIG;
  }

  const redact = createRedactor(secretValues(config));
  const logger = createLogger({
    level: 'error',
    redact,
    write: (_level, line) => io.stderr(line),
  }).child({ component: 'reseal' });
  // The catalog of the plugins the instance itself registers: the bundled ones, the
  // pins of `plugins.dir`, `plugins.enabled` (the root's `loadPlugins`), so a risk a
  // pinned plugin declares is known here as at boot — and, once the store is open, the
  // risk ids of every installed version it keeps, as the root accepts them (a catalog
  // plugin installed at a first connection is compiled nowhere).
  let catalog: CatalogIndex;
  let registryIndex: RegistryCatalogIndex | null = null;
  try {
    if (deps.catalog) catalog = await deps.catalog();
    else {
      registryIndex = new RegistryCatalogIndex(
        (await loadPlugins(config, logger, { bundled: SHIPPED_PLUGINS })).registry,
      );
      catalog = new DeferredCatalogIndex();
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr(`reseal: the plugins of this instance did not load:\n${redact(err.message)}\n`);
      return EXIT_CONFIG;
    }
    throw err;
  }
  let store: Store;
  try {
    const encryptor = await (deps.encryptor ?? ((l) => createEncryptor(l.config.encryption)))(
      loaded,
    );
    store = await (deps.openStore ?? openEmbeddedStore)({ config, logger, encryptor, catalog });
  } catch (err) {
    io.stderr(`reseal: the store could not be opened: ${redact(errorText(err))}\n`);
    return EXIT_CONFIG;
  }

  if (registryIndex !== null && catalog instanceof DeferredCatalogIndex) {
    catalog.fill(new KeptCatalogIndex(registryIndex, await store.pluginVersions.keptRiskIds()));
  }
  try {
    const report = await store.sealedBlobs.reseal({ apply: parsed.apply });
    const remaining = await store.sealedBlobs.versions();
    io.stdout(
      renderReseal({
        report,
        remaining,
        previousKeyVersions: [...config.encryption.previousKeys.keys()].sort((a, b) => a - b),
      }),
    );
    const incomplete = report.tables.some(
      (t) => t.currentUnreadable > 0 || t.unreadable > 0 || t.changed > 0,
    );
    return incomplete ? EXIT_INCOMPLETE : EXIT_OK;
  } finally {
    try {
      await store.close();
    } catch {
      // expected: a store that does not close is said on stderr, details withheld
      io.stderr('reseal: the store did not close cleanly (details withheld).\n');
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
