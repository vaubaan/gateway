/**
 * Test fixtures for mission issuance. Not for production.
 *
 * `ACME_CATALOG` is a small catalog with every shape issuance must handle
 * (account-scoped and env-scoped risks, a rate ceiling, a deprecated entry,
 * the fallback, three macro-actions, one of which holds env-scoped risks by
 * their base id); `acmeConnection()` is the issuance context of
 * one connection on it, for the pure tests. `seedConnection()` writes a
 * connection and its resources straight through the store repositories, the
 * way the Connections feature will, for the integration and browser tests.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import type { Principal, RiskCatalog } from '@vaubaan/shared';

import { fullCatalogRiskIds } from '../../../src/server/authority';
import type { Store } from '../../../src/server/store';
import type { ConnectionRecord, ConnectionResourceRecord } from '../../../src/server/store/types';
import { enumerateCatalog } from '../../../src/lib/missions/catalog-view';
import { macroActionsOf } from '../../../src/lib/missions/macro-actions';
import type { IssuanceConnection, IssuanceResource } from '../../../src/lib/missions/model';

const READ_VECTOR = {
  reversibility: 'reversible',
  blast: 'single',
  data: 'data',
  cost: 'free',
  visibility: 'internal',
} as const;

export const ACME_CATALOG: RiskCatalog = {
  provider: 'acme',
  risks: [
    {
      id: 'acme.read',
      label: 'Read things',
      reason: 'Reads leak nothing but the thing itself.',
      matches: 'acme.space[**].thing[**].R',
      vector: READ_VECTOR,
    },
    {
      id: 'acme.write',
      label: 'Write a thing',
      reason: 'Reversible edit of one thing.',
      matches: 'acme.space[**].thing[one].W',
      acceptable_in_envs: ['staging', 'prod'],
      vector: { ...READ_VECTOR, reversibility: 'costly' },
      vector_overrides: { prod: { blast: 'env', visibility: 'public' } },
    },
    {
      id: 'acme.bulk-delete',
      label: 'Delete things in bulk',
      reason: 'No undo.',
      matches: 'acme.space[**].thing[bulk].W',
      acceptable_in_envs: ['staging'],
      vector: {
        reversibility: 'irreversible',
        blast: 'bulk',
        data: 'data',
        cost: 'moderate',
        visibility: 'team',
      },
    },
    {
      id: 'acme.admin',
      label: 'Change account settings',
      reason: 'Changes the posture of the whole account.',
      matches: 'acme.account.settings.W',
      vector: {
        reversibility: 'costly',
        blast: 'account',
        data: 'secret',
        cost: 'free',
        visibility: 'team',
      },
      infra_limits: { calls_per_minute_max: 10 },
    },
    {
      id: 'acme.legacy-export',
      label: 'Legacy export',
      reason: 'Kept for old missions.',
      matches: 'acme.account.export.R',
      vector: READ_VECTOR,
      deprecated: true,
      replaced_by: 'acme.read',
    },
    {
      id: 'acme.uncategorized-write',
      label: 'Uncategorized write',
      reason: 'Catch-all for writes the catalog does not name.',
      matches: 'acme.**.W',
      fallback: true,
      vector: { ...READ_VECTOR, reversibility: 'costly', blast: 'env' },
    },
  ],
  macro_actions: [
    {
      id: 'read',
      label: 'Read',
      description: 'Read records.',
      entries: [{ risk_id: 'acme.read', quota: 100, rate_limit: { max: 60, window_seconds: 60 } }],
    },
    {
      id: 'change',
      label: 'Change',
      description: 'Write and bulk-delete records.',
      entries: [
        { risk_id: 'acme.write', quota: 100, rate_limit: { max: 60, window_seconds: 60 } },
        { risk_id: 'acme.bulk-delete', quota: 5, rate_limit: { max: 1, window_seconds: 60 } },
      ],
    },
    {
      id: 'administer',
      label: 'Administer',
      description: 'Administer the account.',
      entries: [{ risk_id: 'acme.admin', quota: 5, rate_limit: { max: 1, window_seconds: 60 } }],
    },
  ],
};

const LISTED = { hidden: false, stale: false, self: false } as const;

export const ACME_RESOURCES: readonly IssuanceResource[] = [
  {
    id: 'res-app-staging',
    ref: 'app-staging',
    display_name: 'App (staging)',
    env: 'staging',
    ...LISTED,
  },
  { id: 'res-app-prod', ref: 'app-prod', display_name: 'App (prod)', env: 'prod', ...LISTED },
  { id: 'res-scratch', ref: 'scratch', display_name: 'Scratch', env: null, ...LISTED },
];

/** A resource the owner hid, and one discovery no longer returns. */
export const ACME_HIDDEN: IssuanceResource = {
  id: 'res-archive',
  ref: 'archive',
  display_name: 'Archive',
  env: 'prod',
  hidden: true,
  stale: false,
  self: false,
};
export const ACME_STALE: IssuanceResource = {
  id: 'res-gone',
  ref: 'gone',
  display_name: 'Gone',
  env: 'staging',
  hidden: false,
  stale: true,
  self: false,
};

/** The issuance context of an owner on one Acme connection. */
export function acmeConnection(overrides: Partial<IssuanceConnection> = {}): IssuanceConnection {
  return {
    id: 'conn-acme',
    provider: 'acme',
    provider_label: 'Acme',
    resource_noun: { one: 'thing', other: 'things' },
    display_name: 'Acme main',
    status: 'active',
    derives_env: false,
    default_env: null,
    basis: 'owner',
    resources: ACME_RESOURCES,
    risks: enumerateCatalog(ACME_CATALOG),
    authority: fullCatalogRiskIds(ACME_CATALOG),
    macro_actions: macroActionsOf(ACME_CATALOG),
    ...overrides,
  };
}

export interface SeedResource {
  readonly ref: string;
  readonly displayName?: string;
  readonly env?: string | null;
}

export interface SeededConnection {
  readonly connection: ConnectionRecord;
  readonly resources: readonly ConnectionResourceRecord[];
}

/** A connection with its resources, written through the repositories only. */
export async function seedConnection(
  store: Pick<Store, 'connections'>,
  input: {
    readonly provider: string;
    readonly owner: Principal;
    readonly displayName: string;
    readonly resources: readonly SeedResource[];
  },
): Promise<SeededConnection> {
  const connection = await store.connections.create({
    provider: input.provider,
    owner: input.owner,
    displayName: input.displayName,
    credential: JSON.stringify({ kind: 'test', note: 'never sent upstream' }),
  });
  const resources = await store.connections.syncDiscoveredResources(
    connection.id,
    input.resources.map((r) => ({
      ref: r.ref,
      displayName: r.displayName ?? r.ref,
      env: r.env ?? null,
    })),
  );
  return { connection, resources };
}

/** Every environment label a provider's catalog names, in first-seen order. */
export function catalogEnvs(registry: PluginRegistry, provider: string): string[] {
  const envs = new Set<string>();
  for (const risk of registry.require(provider).plugin.catalog.risks) {
    for (const env of risk.acceptable_in_envs ?? []) envs.add(env);
  }
  return [...envs];
}
