/**
 * `@crm/core/secret-manager` — runtime SecretManager backends.
 *
 * Spec docs/spec/cloud-resource-manager.md §5.2 (Contrat `SecretManager`).
 *
 * - `interface.ts`        — the in-tree contract (re-exported as
 *                           `SecretManager` / `SealedBlob`).
 * - `db.ts`               — default v1 backend (Postgres
 *                           `resource_access.sealed_blob`).
 * - `infisical-client.ts` — low-level REST client for Infisical.
 * - `infisical.ts`        — `infisical` SM (the built-in v1 plugin).
 *
 * v1 ships **two** factories — `createDbSecretManager` (default) and
 * `createInfisicalSecretManager`. Vault / 1Password stubs are out of
 * scope per the build plan (`out_of_scope_for_phase_5`).
 */

export type { SealedBlob, SecretManager } from './interface.js';
export {
  createDbSecretManager,
  decodeSealedBytea,
  encodeSealedBytea,
  SecretManagerError,
  type DbSecretManagerOptions,
  type DbSupabaseLike,
  type DbFromTable,
  type DbSelectChain,
  type DbDeleteChain,
  type DbResult,
} from './db.js';
export {
  createInfisicalSecretManager,
  InfisicalSmError,
  type InfisicalSecretManagerOptions,
} from './infisical.js';
export {
  createInfisicalClient,
  InfisicalApiError,
  type InfisicalAuthCredentials,
  type InfisicalClient,
  type InfisicalClientOptions,
  type InfisicalSecret,
} from './infisical-client.js';
