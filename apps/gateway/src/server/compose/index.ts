export {
  buildRoot,
  getRoot,
  resetRoot,
  type BuildInfo,
  type GatewayRoot,
  type RootDeps,
} from './root';
export { bootOrExit, EXIT_BOOT_ERROR, EXIT_CONFIG_ERROR, type BootIo } from './boot';
export type {
  CacheClient,
  RateLimitDecision,
  RateLimiter,
  SessionStore,
  StoreLiveness,
} from './ports';
export { MemoryRateLimiter, MemorySessionStore } from './memory';
export { buildEmptyRegistry, checkProviderApps, RegistryCatalogIndex } from './registry';
export { buildShippedRegistry, SHIPPED_PLUGINS } from './shipped-plugins';
export { openEmbeddedStore, type StoreContext } from './store';
