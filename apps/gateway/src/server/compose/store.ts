/**
 * Store wiring — the root opens the embedded SQLite store (P0.3) from
 * `InstanceConfig.store.path`, with the encryptor it built and a catalog
 * index derived from the plugin registry. Migrations run inside
 * `openStore()`, so a process that reaches "store opened" has a current
 * schema. `openMemoryStore` (the `:memory:` mode) is what tests inject
 * instead; see `testing.ts`.
 */
import { envNamesFor, type InstanceConfig } from '../config';
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
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `store.path '${path}' (env: ${envNamesFor('store.path').join(' or ')}): cannot open the embedded store: ${reason}`,
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
