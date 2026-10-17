/**
 * The one place a stored connection becomes the shapes other modules show or
 * put on the wire. `ConnectionRecord` (camelCase) stays the read model of the
 * services; what leaves a service in snake_case goes through here, so a field
 * added to a connection is added once.
 */
import { isCredentialKind, type ConnectionStatus, type CredentialKind } from '@vaubaan/shared';

import type { Store } from '../store';
import type { ConnectionRecord, Principal } from '../store/types';

/** The identity of a connection as every snake_case view carries it. */
export interface ConnectionSummary {
  readonly id: string;
  readonly provider: string;
  readonly display_name: string;
  readonly status: ConnectionStatus;
}

export function connectionSummaryOf(record: ConnectionRecord): ConnectionSummary {
  return {
    id: record.id,
    provider: record.provider,
    display_name: record.displayName,
    status: record.status,
  };
}

/**
 * The owner of a connection with the name a human recognises: the user's
 * email or the group's name. `name` is `null` when the user or the group no
 * longer exists; each caller words that case for its own reader.
 */
export type ResolvedConnectionOwner = Principal & { readonly name: string | null };

export async function connectionOwnerOf(
  store: Pick<Store, 'users' | 'groups'>,
  connection: Pick<ConnectionRecord, 'owner'>,
): Promise<ResolvedConnectionOwner> {
  const { owner } = connection;
  if (owner.kind === 'group') {
    const group = await store.groups.getById(owner.id);
    return { ...owner, name: group?.name ?? null };
  }
  const user = await store.users.getById(owner.id);
  return { ...owner, name: user?.email ?? null };
}

/**
 * How a connection was made: `metadata.credential_kind`, which every connect
 * and reconnect writes. A record without it is read as the plugin's primary
 * kind, `null` when the plugin is gone too. A plugin may connect in more than
 * one way (ADR token-connections-beside-the-integration-app), so the plugin
 * alone no longer says how one of its connections was made.
 */
export function connectionCredentialKind(
  record: { readonly metadata?: ConnectionRecord['metadata'] },
  primaryKind: CredentialKind | null,
): CredentialKind | null {
  const stored = record.metadata?.credential_kind;
  return typeof stored === 'string' && isCredentialKind(stored) ? stored : primaryKind;
}

/**
 * The non-secret fields of the form a connection was made with
 * (`metadata.fields`, the visible values only; secrets live in the sealed
 * credential). Shown on the account page and handed to the plugin's
 * classifier (`ClassifyConnection`). Anything that is not a string is dropped.
 */
export function connectionPublicFields(record: {
  readonly metadata?: ConnectionRecord['metadata'];
}): Record<string, string> {
  const value = record.metadata?.fields;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) if (typeof v === 'string') out[key] = v;
  return out;
}
