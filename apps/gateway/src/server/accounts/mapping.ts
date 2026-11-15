/**
 * The one place a stored account becomes the shapes other modules show or
 * put on the wire. `AccountRecord` (camelCase) stays the read model of the
 * services; what leaves a service in snake_case goes through here, so a field
 * added to an account is added once.
 */
import { type AccountStatus, type CredentialKind } from '@vaubaan/shared';

import type { Store } from '../store';
import type { AccountRecord, Principal } from '../store/types';

/** The identity of an account as every snake_case view carries it. */
export interface AccountSummary {
  readonly id: string;
  readonly service: string;
  readonly display_name: string;
  readonly status: AccountStatus;
}

export function accountSummaryOf(record: AccountRecord): AccountSummary {
  return {
    id: record.id,
    service: record.service,
    display_name: record.displayName,
    status: record.status,
  };
}

/**
 * When discovery last ran on the account, whatever ran it and however it ended
 * (`metadata.discovery.at`, written by `AccountService.recordDiscovery`); `null`
 * when never.
 */
export function lastDiscoveryAt(record: Pick<AccountRecord, 'metadata'>): string | null {
  const discovery = record.metadata?.discovery;
  if (typeof discovery !== 'object' || discovery === null) return null;
  const at = (discovery as { at?: unknown }).at;
  return typeof at === 'string' ? at : null;
}

/**
 * The owner of an account with the name a human recognises: the user's
 * email or the group's name. `name` is `null` when the user or the group no
 * longer exists; each caller words that case for its own reader.
 */
export type ResolvedAccountOwner = Principal & { readonly name: string | null };

export async function accountOwnerOf(
  store: Pick<Store, 'users' | 'groups'>,
  account: Pick<AccountRecord, 'owner'>,
): Promise<ResolvedAccountOwner> {
  const { owner } = account;
  if (owner.kind === 'group') {
    const group = await store.groups.getById(owner.id);
    return { ...owner, name: group?.name ?? null };
  }
  const user = await store.users.getById(owner.id);
  return { ...owner, name: user?.email ?? null };
}

/**
 * How an account was made: `metadata.credential_kind`, which every connect
 * and reconnect writes, kept as the word stored — a kind the contract no
 * longer knows (`app-install`, the GitHub App of earlier builds) is returned
 * as is, so that such an account is told apart from the plugin's way and
 * refused until reconnected (ADR one-place-to-authorize-services-token-first).
 * A record without it is read as the plugin's kind, `null` when the plugin is
 * gone too.
 */
export function accountCredentialKind(
  record: { readonly metadata?: AccountRecord['metadata'] },
  primaryKind: CredentialKind | null,
): StoredCredentialKind | null {
  const stored = record.metadata?.credential_kind;
  return typeof stored === 'string' && stored.length > 0 ? stored : primaryKind;
}

/** A credential kind as an account stores it: one of the contract's, or a word it no longer knows. */
export type StoredCredentialKind = CredentialKind | (string & {});

/**
 * Whether an account was made a way its plugin no longer declares (the GitHub
 * App of earlier builds, a Gmail account connected by OAuth before Gmail moved
 * to an app password): such an account runs nothing, discovers nothing, and is
 * reconnected the way the service now offers. An account whose kind is not
 * known reads as the plugin's.
 */
export function isRetiredWay(
  storedKind: StoredCredentialKind | null,
  pluginKind: CredentialKind,
): boolean {
  return storedKind !== null && storedKind !== pluginKind;
}

/** The one sentence a retired way is refused with: by a call, by a discovery. */
export function retiredWayReason(serviceLabel: string, storedKind: StoredCredentialKind): string {
  return `this account was connected a way ${serviceLabel} no longer offers on this gateway (${storedKind}); its owner reconnects it from Accounts.`;
}

/**
 * The non-secret fields of the form an account was made with
 * (`metadata.fields`, the visible values only; secrets live in the sealed
 * credential). Shown on the account page and handed to the plugin's
 * classifier (`ClassifyAccount`). Anything that is not a string is dropped.
 */
export function accountPublicFields(record: {
  readonly metadata?: AccountRecord['metadata'];
}): Record<string, string> {
  const value = record.metadata?.fields;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) if (typeof v === 'string') out[key] = v;
  return out;
}
