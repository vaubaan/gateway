/**
 * The catalog version a gateway offers or installs for a plugin: the versions feed's latest,
 * never below the version this release knows (`catalog-versions.json`). The feed is read
 * over the network and is not signed: it may name a newer version, which the catalog's
 * signature then vouches for, but never take an instance back to an older signed release
 * with a flaw this release already moved past.
 */
import { gte, valid } from 'semver';

export interface KnownVersion {
  readonly version: string;
}

/** `released` (the feed's) when it is a version at or above `known`; `known` otherwise. */
export function catalogVersionFloor(
  released: string | undefined,
  known: KnownVersion | undefined,
): string | null {
  const offered = released !== undefined && valid(released) !== null ? released : undefined;
  if (offered === undefined) return known?.version ?? null;
  if (known === undefined) return offered;
  return gte(offered, known.version) ? offered : known.version;
}
