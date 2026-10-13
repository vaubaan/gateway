/**
 * Store wiring — the root opens the embedded SQLite store (P0.3) from
 * `InstanceConfig.store.path`, with the encryptor it built and a catalog
 * index derived from the plugin registry. Migrations run inside
 * `openStore()`, so a process that reaches "store opened" has a current
 * schema. `openMemoryStore` (the `:memory:` mode) is what tests inject
 * instead; see `testing.ts`.
 */
import { envNamesFor, errorMessage, formatIssue, type InstanceConfig } from '../config';
import type { Encryptor } from '../crypto';
import type { Logger } from '../logging';
import { openStore, type CatalogIndex, type Store } from '../store';

/** What `RootDeps.openStore` receives. */
export interface StoreContext {
  readonly config: InstanceConfig;
  readonly logger: Logger;
  readonly encryptor: Encryptor;
  readonly catalog: CatalogIndex;
}

/** The default `RootDeps.openStore`: the SQLite file of the configuration. */
export async function openEmbeddedStore(ctx: StoreContext): Promise<Store> {
  const path = ctx.config.store.path;
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
