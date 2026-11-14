/**
 * What a pasted token holds against what the plugin's guide asks the person to
 * tick (account-ux audit 2026-10-31, M2). A plugin whose provider can list a
 * token's permissions returns their names from `verify` (`CredentialCheck.granted`);
 * the account keeps them in its metadata and the account page names each
 * permission of `guide.permissions` the token lacks, with the tools that need it.
 * A provider that cannot say (GitHub's fine-grained tokens) leaves it `null`: the
 * page then says nothing rather than guess.
 */
import type { CredentialSpec, TokenPermission } from '@vaubaan/plugin-sdk';

/** More names than any provider's token page lists; the rest is dropped. */
const MAX_GRANTED = 200;
const MAX_NAME_LENGTH = 120;

/** The names a plugin said the token holds, as stored: trimmed, one line, bounded, unique. */
export function grantedNames(raw: readonly unknown[]): string[] {
  const names = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const name = value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
    if (name !== '') names.add(name);
    if (names.size >= MAX_GRANTED) break;
  }
  return [...names];
}

/**
 * The permissions of the guide the token does not hold; `null` when the service did
 * not say what it holds (nothing stored), or the way has no guide.
 */
export function tokenLacks(spec: CredentialSpec, granted: unknown): TokenPermission[] | null {
  if (spec.kind !== 'api-key' || !spec.guide || !Array.isArray(granted)) return null;
  const held = new Set(grantedNames(granted).map((name) => name.toLowerCase()));
  return spec.guide.permissions.filter((permission) => !held.has(permission.name.toLowerCase()));
}
