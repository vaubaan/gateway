/**
 * The effective environment of a connection's resource (spec §0 "Resource"; ADR
 * connection-default-environment-label): its own label, set by the owner or by
 * the plugin, always wins; else the default its connection's owner chose; else
 * none. The connections repository applies it on every resource it reads, so that
 * issuance, the execution door, the management door and the pages read one value.
 */
import type {
  ConnectionResourceRecord,
  ResourceEnvSource,
  StoredResourceEnvSource,
} from './types.ts';

export interface EffectiveEnv {
  readonly env: string | null;
  readonly envSource: ResourceEnvSource;
}

export function effectiveResourceEnv(
  own: { readonly env: string | null; readonly envSource: StoredResourceEnvSource },
  connectionDefault: string | null,
): EffectiveEnv {
  if (own.env !== null || connectionDefault === null) return own;
  return { env: connectionDefault, envSource: 'connection-default' };
}

/** The resource's own label, the one its owner edits: `null` when it only inherits the default. */
export function ownResourceEnv(
  resource: Pick<ConnectionResourceRecord, 'env' | 'envSource'>,
): string | null {
  return resource.envSource === 'connection-default' ? null : resource.env;
}
