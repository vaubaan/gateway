/**
 * The published versions feed (`versions.json`): what the project's website serves and
 * what an instance reads at start and daily to tell its operator what is behind (ADR
 * plugins-bundled-or-pinned-by-the-operator, "Information travels, code does not").
 *
 * One shape for both sides: the website builds it from `releases.json` and
 * `advisories.json` (`apps/website/src/content/`), the gateway checks what it fetched
 * with `isVersionsFeed` before reading anything of it. The feed is untrusted on the
 * gateway's side: every string is bounded, every link is https.
 *
 * Pure, no dependency: imported by the website and the server alike
 * (`@vaubaan/shared/versions-feed`).
 */

/** The only schema an instance reads; a feed of another schema is ignored. */
export const VERSIONS_FEED_SCHEMA = 1;

/** What an advisory is about: the gateway, or one plugin by its id. */
export type AdvisorySubject = 'gateway' | `plugin:${string}`;

/** A security advisory: the versions it affects and the one that fixes it. */
export interface VersionsFeedAdvisory {
  /** `VBN-<year>-<nnn>`. */
  readonly id: string;
  readonly subject: AdvisorySubject;
  /** A semver range of the affected versions (`>=4.0.0 <5.0.1`). */
  readonly affected: string;
  /** The first version that fixes it. */
  readonly fixed: string;
  readonly summary: string;
  /** Where the advisory is explained; https. */
  readonly url: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
}

export interface VersionsFeed {
  readonly schema: typeof VERSIONS_FEED_SCHEMA;
  /** ISO 8601 date-time of the feed's generation. */
  readonly generated_at: string;
  readonly gateway: {
    /** The latest released gateway version (`2.0.0-alpha.16`). */
    readonly latest: string;
    readonly prerelease: boolean;
  };
  /** The latest released version of each plugin, by plugin id. */
  readonly plugins: Readonly<Record<string, { readonly latest: string }>>;
  readonly advisories: readonly VersionsFeedAdvisory[];
}

/** Bounds of an untrusted feed: anything beyond is not a feed this instance reads. */
export const VERSIONS_FEED_LIMITS = {
  plugins: 500,
  advisories: 500,
  text: 1_000,
  short: 200,
} as const;

/** A semver version, prerelease and build included (semver.org §2, §9, §10). */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;
const ADVISORY_ID = /^VBN-\d{4}-\d{3,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isText(x: unknown, max: number): x is string {
  return typeof x === 'string' && x.trim() !== '' && x.length <= max;
}

/** Whether `x` is a semver version string. */
export function isSemverVersion(x: unknown): x is string {
  return isText(x, VERSIONS_FEED_LIMITS.short) && SEMVER.test(x);
}

function isHttpsUrl(x: unknown): x is string {
  if (!isText(x, VERSIONS_FEED_LIMITS.text)) return false;
  try {
    return new URL(x).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether `x` names the gateway or a plugin id. */
export function isAdvisorySubject(x: unknown): x is AdvisorySubject {
  if (x === 'gateway') return true;
  return typeof x === 'string' && x.startsWith('plugin:') && PLUGIN_ID.test(x.slice(7));
}

/** Whether `x` is one advisory of the feed. */
export function isVersionsFeedAdvisory(x: unknown): x is VersionsFeedAdvisory {
  if (!isRecord(x)) return false;
  return (
    typeof x['id'] === 'string' &&
    ADVISORY_ID.test(x['id']) &&
    isAdvisorySubject(x['subject']) &&
    isText(x['affected'], VERSIONS_FEED_LIMITS.short) &&
    isSemverVersion(x['fixed']) &&
    isText(x['summary'], VERSIONS_FEED_LIMITS.text) &&
    isHttpsUrl(x['url']) &&
    typeof x['date'] === 'string' &&
    DATE.test(x['date'])
  );
}

/**
 * Whether `x` is a versions feed this instance reads: schema 1, every field of the
 * shape above, within `VERSIONS_FEED_LIMITS`. Unknown extra fields are allowed (a later
 * schema 1 may add some); one malformed entry refuses the whole feed.
 */
export function isVersionsFeed(x: unknown): x is VersionsFeed {
  if (!isRecord(x) || x['schema'] !== VERSIONS_FEED_SCHEMA) return false;
  const generatedAt = x['generated_at'];
  if (!isText(generatedAt, VERSIONS_FEED_LIMITS.short) || Number.isNaN(Date.parse(generatedAt))) {
    return false;
  }
  const gateway = x['gateway'];
  if (!isRecord(gateway) || !isSemverVersion(gateway['latest'])) return false;
  if (typeof gateway['prerelease'] !== 'boolean') return false;
  const plugins = x['plugins'];
  if (!isRecord(plugins)) return false;
  const entries = Object.entries(plugins);
  if (entries.length > VERSIONS_FEED_LIMITS.plugins) return false;
  for (const [id, entry] of entries) {
    if (!PLUGIN_ID.test(id) || !isRecord(entry) || !isSemverVersion(entry['latest'])) return false;
  }
  const advisories = x['advisories'];
  return (
    Array.isArray(advisories) &&
    advisories.length <= VERSIONS_FEED_LIMITS.advisories &&
    advisories.every(isVersionsFeedAdvisory)
  );
}
