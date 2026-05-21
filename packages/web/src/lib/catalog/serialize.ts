/**
 * Wire serialisation of `ResourceKind` for the `GET /api/crm/v1/catalog`
 * family of endpoints. Spec §6.1.
 *
 * Why a dedicated helper: a `ResourceKind` carries **functions**
 * (`healthTestCmd`, `mcpFragment`, `rotateSelf`, and on org-admin
 * kinds: `listChildren`, `createChild`, `destroyChild`,
 * `rotateChildAccess`). Those are runtime-only and must NOT leak on
 * the wire (would be `null` after `JSON.stringify` anyway — making it
 * explicit prevents accidental coupling).
 *
 * Fields kept on the wire:
 *   - `id`, `provider`, `kindClass`, `displayName`
 *   - `setupDocs` (markdown plain text)
 *   - `accessSchema` (object keyed by `KEY`, each entry has
 *     `label`, optional `description`, `required`, optional `pattern`)
 *   - `rotationMethod`
 *   - `egressHosts` — invoked with `{}` (empty metadata bag) to get
 *     the static allowlist. Per-resource hosts (e.g. a Supabase
 *     project's wildcard subdomain) are computed at runtime by the
 *     Resource, not at the catalogue layer.
 *   - `manages` (only when `kindClass === 'org-admin'`).
 */

import type { OrgResourceAdminKind, ResourceKind } from '@crm/catalog';

export interface SerializedAccessKey {
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
  readonly pattern?: string;
}

export interface SerializedKindBase {
  readonly id: string;
  readonly provider: string;
  readonly kindClass: 'org' | 'project' | 'org-admin';
  readonly displayName: string;
  readonly setupDocs: string;
  readonly accessSchema: Readonly<Record<string, SerializedAccessKey>>;
  readonly rotationMethod: 'self' | 'admin-mediated' | 'manual';
  readonly egressHosts: readonly string[];
}

export interface SerializedOrgAdminKind extends SerializedKindBase {
  readonly kindClass: 'org-admin';
  readonly manages: readonly string[];
}

export type SerializedKind = SerializedKindBase | SerializedOrgAdminKind;

function isOrgAdminKind(k: ResourceKind): k is OrgResourceAdminKind {
  return k.kindClass === 'org-admin';
}

export function serializeKind(k: ResourceKind): SerializedKind {
  const accessSchema: Record<string, SerializedAccessKey> = {};
  for (const [key, spec] of Object.entries(k.accessSchema)) {
    const entry: SerializedAccessKey = {
      label: spec.label,
      required: spec.required,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.pattern !== undefined ? { pattern: spec.pattern } : {}),
    };
    accessSchema[key] = entry;
  }

  const base: SerializedKindBase = {
    id: k.id,
    provider: k.provider,
    kindClass: k.kindClass,
    displayName: k.displayName,
    setupDocs: k.setupDocs,
    accessSchema,
    rotationMethod: k.rotationMethod,
    egressHosts: [...k.egressHosts({})],
  };

  if (isOrgAdminKind(k)) {
    const admin: SerializedOrgAdminKind = {
      ...base,
      kindClass: 'org-admin',
      manages: [...k.manages],
    };
    return admin;
  }
  return base;
}
