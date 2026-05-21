/**
 * @crm/catalog — contracts + concrete catalogue of the Cloud Resource Manager.
 *
 * Spec reference: docs/spec/cloud-resource-manager.md §5.1 (ResourceKind /
 * OrgResourceAdminKind), §5.2 (SecretManager), §5.3 (provider catalogue
 * layout), §6.1 (REST endpoint).
 *
 * Public surface:
 *   - Types: `ResourceKind`, `OrgResourceAdminKind`, `KindClass`,
 *     `RotationMethod`, `AccessKeySpec`, `McpServerFragment`,
 *     `ProviderChild`, plus `SealedBlob`, `SealedRecipient`,
 *     `SecretManager`.
 *   - Registry: `CATALOG` (frozen list of 9 ResourceKinds in v1) and
 *     `findKind(id)` helper. Phase 3 wave B (`feature/catalog-registry-and-endpoint`).
 *   - Per-provider barrels are NOT re-exported from the root — callers
 *     that need a specific kind import via `findKind('github-org')` or
 *     consume the `CATALOG` array.
 */

export type {
  AccessKeySpec,
  KindClass,
  McpServerFragment,
  OrgResourceAdminKind,
  ProviderChild,
  ResourceKind,
  RotationMethod,
} from './resource-kind.js';

export type { SealedBlob, SealedRecipient, SecretManager } from './secret-manager.js';

export { CATALOG, findKind } from './registry.js';
