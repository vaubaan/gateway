/**
 * The effective environment of an account's resource (spec §0 "Resource"; ADR
 * connect-driver-and-resource-curation): its own label, set by the owner or by
 * the plugin, always wins; else the default its account's owner chose; else
 * none. The accounts repository applies it on every resource it reads, so that
 * issuance, the execution door, the management door and the pages read one value.
 */
import type { AccountResourceRecord, ResourceEnvSource, StoredResourceEnvSource } from './types.ts';

export interface EffectiveEnv {
  readonly env: string | null;
  readonly envSource: ResourceEnvSource;
}

export function effectiveResourceEnv(
  own: { readonly env: string | null; readonly envSource: StoredResourceEnvSource },
  accountDefault: string | null,
): EffectiveEnv {
  if (own.env !== null || accountDefault === null) return own;
  return { env: accountDefault, envSource: 'account-default' };
}

/** The resource's own label, the one its owner edits: `null` when it only inherits the default. */
export function ownResourceEnv(
  resource: Pick<AccountResourceRecord, 'env' | 'envSource'>,
): string | null {
  return resource.envSource === 'account-default' ? null : resource.env;
}
