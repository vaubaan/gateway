/**
 * What the versions feed says about this instance, compared locally (ADR
 * plugins-bundled-or-pinned-by-the-operator): nothing about the instance left it, so
 * everything Administration › Plugins shows is computed here. Pure.
 */
import type { VersionsFeed } from '@vaubaan/shared';
import { lt, satisfies, valid, validRange } from 'semver';

import type { PluginInventoryEntry } from '../plugins';

/** The gateway against the released one. */
export interface GatewayVersionCheck {
  readonly current: string;
  readonly latest: string;
  /** `latest` is a prerelease, as the feed says. */
  readonly latestIsPrerelease: boolean;
  /** `current` is older than `latest`; `false` when `current` is not a release (`dev`). */
  readonly behind: boolean;
}

/** A plugin whose loaded version is older than the released one. */
export interface PluginBehind {
  readonly id: string;
  readonly loaded: string;
  readonly released: string;
}

/** A catalog plugin this instance has no version of: offered for a one-click install. */
export interface PluginAvailable {
  readonly id: string;
  readonly released: string;
}

/** An advisory whose affected range holds the version this instance runs. */
export interface AdvisoryHit {
  readonly id: string;
  /** `gateway`, or the plugin's id. */
  readonly subject: 'gateway' | { readonly plugin: string };
  /** The version this instance runs. */
  readonly loaded: string;
  readonly affected: string;
  readonly fixed: string;
  readonly summary: string;
  readonly url: string;
  readonly date: string;
}

/** A pin older than the bundled version it replaces: the image carries newer. */
export interface OlderPin {
  readonly id: string;
  readonly pinned: string;
  readonly bundled: string;
  readonly path: string | null;
}

export interface UpdatesComparison {
  /** When the feed was generated, as it says. */
  readonly feedGeneratedAt: string;
  readonly gateway: GatewayVersionCheck;
  readonly pluginsBehind: readonly PluginBehind[];
  /** The feed's plugins the instance knows of no version, sorted by id. */
  readonly pluginsAvailable: readonly PluginAvailable[];
  readonly advisories: readonly AdvisoryHit[];
  readonly olderPins: readonly OlderPin[];
}

export interface CompareInput {
  readonly gatewayVersion: string;
  readonly inventory: readonly PluginInventoryEntry[];
}

const PRERELEASES = { includePrerelease: true } as const;

function isOlder(version: string, than: string): boolean {
  return valid(version) !== null && valid(than) !== null && lt(version, than);
}

function affects(range: string, version: string): boolean {
  return (
    validRange(range) !== null && valid(version) !== null && satisfies(version, range, PRERELEASES)
  );
}

/**
 * Compares the feed with the gateway version and every plugin the instance knows,
 * registered or not (a disabled plugin is still in the image). An advisory with a range
 * semver cannot read is ignored, never a hit.
 */
export function compare(feed: VersionsFeed, input: CompareInput): UpdatesComparison {
  const { gatewayVersion, inventory } = input;
  const pluginsBehind: PluginBehind[] = [];
  const olderPins: OlderPin[] = [];
  for (const entry of inventory) {
    // The feed speaks of the catalog's plugins: an installed version Vaubaan did not sign
    // shares, at most, an id with one of them (a private `crm`, a catalog `crm`).
    if (entry.origin === 'installed' && entry.trust !== 'vaubaan') continue;
    const released = feed.plugins[entry.id]?.latest;
    if (released !== undefined && isOlder(entry.version, released)) {
      pluginsBehind.push({ id: entry.id, loaded: entry.version, released });
    }
    if (
      entry.origin === 'pinned' &&
      entry.replaces !== null &&
      isOlder(entry.version, entry.replaces)
    ) {
      olderPins.push({
        id: entry.id,
        pinned: entry.version,
        bundled: entry.replaces,
        path: entry.path,
      });
    }
  }

  const advisories: AdvisoryHit[] = [];
  for (const advisory of feed.advisories) {
    const { subject, ...rest } = advisory;
    const hit = (loaded: string, about: AdvisoryHit['subject']): void => {
      if (affects(advisory.affected, loaded)) {
        advisories.push({ ...rest, subject: about, loaded });
      }
    };
    if (subject === 'gateway') {
      hit(gatewayVersion, 'gateway');
      continue;
    }
    const pluginId = subject.slice('plugin:'.length);
    for (const entry of inventory) {
      if (entry.id !== pluginId) continue;
      if (entry.origin === 'installed' && entry.trust !== 'vaubaan') continue;
      hit(entry.version, { plugin: entry.id });
    }
  }

  return {
    feedGeneratedAt: feed.generated_at,
    gateway: {
      current: gatewayVersion,
      latest: feed.gateway.latest,
      latestIsPrerelease: feed.gateway.prerelease,
      behind: isOlder(gatewayVersion, feed.gateway.latest),
    },
    pluginsBehind,
    pluginsAvailable: Object.entries(feed.plugins)
      .filter(([id]) => !inventory.some((entry) => entry.id === id))
      .map(([id, { latest }]) => ({ id, released: latest }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    advisories,
    olderPins,
  };
}
