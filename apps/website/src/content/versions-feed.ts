/**
 * The versions feed (`/versions.json`, website spec §2.4 bis; ADR
 * plugins-bundled-or-pinned-by-the-operator): what an instance reads to know whether it
 * is behind. Built from two committed files of `src/content/`: `releases.json`
 * (written by `npm run release:prepare`) and `advisories.json` (written by hand in a
 * fix's pull request). Pure: the route passes the files and the build time.
 *
 * The result is checked with the guard the gateway runs on what it fetches
 * (`isVersionsFeed`): a malformed data file throws here, so the build fails rather
 * than publish a feed every instance would ignore.
 */
import {
  isVersionsFeed,
  VERSIONS_FEED_SCHEMA,
  type VersionsFeed,
} from '@vaubaan/shared/versions-feed';

/** `releases.json`: the last released gateway and the released version of each plugin. */
export interface ReleasesData {
  readonly gateway: string;
  readonly prerelease: boolean;
  readonly date: string;
  readonly plugins: Readonly<Record<string, string>>;
}

function isReleasesData(x: unknown): x is ReleasesData {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  const plugins = r['plugins'];
  return (
    typeof r['gateway'] === 'string' &&
    typeof r['prerelease'] === 'boolean' &&
    typeof r['date'] === 'string' &&
    typeof plugins === 'object' &&
    plugins !== null &&
    !Array.isArray(plugins) &&
    Object.values(plugins).every((v) => typeof v === 'string')
  );
}

/** The feed of `releases` and `advisories`, generated at `generatedAt`; throws on a malformed file. */
export function buildVersionsFeed(
  releases: unknown,
  advisories: unknown,
  generatedAt: Date,
): VersionsFeed {
  if (!isReleasesData(releases)) {
    throw new Error('src/content/releases.json is not { gateway, prerelease, date, plugins }');
  }
  const feed = {
    schema: VERSIONS_FEED_SCHEMA,
    generated_at: generatedAt.toISOString(),
    gateway: { latest: releases.gateway, prerelease: releases.prerelease },
    plugins: Object.fromEntries(
      Object.entries(releases.plugins).map(([id, latest]) => [id, { latest }]),
    ),
    advisories,
  };
  if (!isVersionsFeed(feed)) {
    throw new Error(
      'the versions feed built from src/content/releases.json and advisories.json is not one an instance reads (isVersionsFeed)',
    );
  }
  return feed;
}
