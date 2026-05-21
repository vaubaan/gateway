/**
 * @crm/catalog — types-only contracts for the Cloud Resource Manager catalogue.
 *
 * Spec reference: docs/spec/cloud-resource-manager.md §5.1 (ResourceKind /
 * OrgResourceAdminKind) and §5.2 (SecretManager).
 *
 * v1 init: this package ships interfaces and discriminator unions ONLY.
 * No provider implementations (no `CATALOG` export, no github / vercel /
 * supabase plugins). Those land in a later phase (cf. build-plan
 * `out_of_scope_for_init`).
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
