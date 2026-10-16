/**
 * Store wiring — the root opens the embedded SQLite store from
 * `InstanceConfig.store.path`, with the encryptor it built and a catalog
 * index derived from the plugin registry. Migrations run inside
 * `openStore()`, so a process that reaches "store opened" has a current
 * schema; a configured first-boot restore runs before (`restore/`). `openMemoryStore` (the `:memory:` mode) is what tests inject
 * instead; see `testing.ts`.
 */
import { envNamesFor, errorMessage, formatIssue, type InstanceConfig } from '../config';
import type { Encryptor } from '../crypto';
import type { Logger } from '../logging';
import { restoreAtFirstBoot } from '../restore/first-boot';
import { openStore, type CatalogIndex, type Store } from '../store';

/** What `RootDeps.openStore` receives. */
export interface StoreContext {
  readonly config: InstanceConfig;
  readonly logger: Logger;
  readonly encryptor: Encryptor;
  readonly catalog: CatalogIndex;
  /** Tests: the network of the first-boot restore. */
  readonly restoreFetch?: typeof fetch;
}

/**
 * The default `RootDeps.openStore`: the SQLite file of the configuration. When
 * `restore.from` is set and the file does not exist yet, the copy is restored
 * first (`restore/first-boot.ts`); a refused restore stops the boot.
 */
export async function openEmbeddedStore(ctx: StoreContext): Promise<Store> {
  const path = ctx.config.store.path;
  await restoreAtFirstBoot({
    config: ctx.config,
    logger: ctx.logger,
    encryptor: ctx.encryptor,
    fetch: ctx.restoreFetch,
  });
  let store: Store;
  try {
    store = openStore({ path, encryptor: ctx.encryptor, catalog: ctx.catalog });
  } catch (err) {
    throw new Error(
      formatIssue({
        path: 'store.path',
        env: envNamesFor('store.path'),
        message: `cannot open the embedded store at '${path}': ${errorMessage(err)}`,
      }),
      { cause: err },
    );
  }
  ctx.logger.info('store opened', {
    kind: store.kind,
    path,
    schema_version: store.schemaVersion,
  });
  return store;
}
