import { isRecord } from './guards.ts';
/**
 * The catalog's index (`index.json` on the catalog repository's GitHub Pages; ADR
 * plugin-catalog-rebuilt-from-source, amendment 2026-11-19): every plugin the catalog
 * published, its service's name, its latest version, the sha256 of that version's
 * archive and, when its archive's manifest declares one, its service's mark (ADR
 * service-icons-declared-by-the-plugin, amendment 2026-11-26). Written by the catalog's release workflow after each release, read by an
 * instance at its versions check and by `npm run release:prepare` at a gateway release.
 *
 * Untrusted on the reading side, like the versions feed: every string is bounded, and an
 * archive is kept only once the catalog's signature verifies and names the id and version
 * asked for; the sha256 only lets an instance refuse a different download early.
 *
 * Pure, no dependency (`@vaubaan/shared/catalog-index`).
 */

/** The only schema an instance reads; an index of another schema is ignored. */
export const CATALOG_INDEX_SCHEMA = 1;

export interface CatalogIndexEntry {
  /** The service's name, as its declaration gives it (`Vercel`). */
  readonly name: string;
  /** The latest version the catalog published. */
  readonly version: string;
  /** The sha256 of that version's archive, lowercase hex. */
  readonly sha256: string;
  /** The `d` of the service's icon on a 24-unit grid, from that version's archive manifest. */
  readonly icon?: string;
  /** The colour the icon is drawn in, `#RRGGBB`. */
  readonly iconColor?: string;
}

export interface CatalogIndex {
  readonly schema: typeof CATALOG_INDEX_SCHEMA;
  /** ISO 8601 date-time of the index's generation. */
  readonly generated_at: string;
  /** By plugin id. */
  readonly plugins: Readonly<Record<string, CatalogIndexEntry>>;
}

/** Bounds of an untrusted index: anything beyond is not an index this instance reads. */
export const CATALOG_INDEX_LIMITS = { plugins: 500, name: 80, short: 200, icon: 8192 } as const;

const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** `SVG_PATH_DATA_PATTERN` and `HEX_COLOUR_PATTERN` of the plugin SDK, which `definePlugin` applies. */
const SVG_PATH_DATA = /^[Mm][0-9A-Za-z.,\s+-]*$/;
const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;

/** A service's mark as an index gives it: the icon's path and its colour (`null`: the ink). */
export interface CatalogMark {
  readonly path: string;
  readonly color: string | null;
}

/**
 * The mark of an index entry, or `null` when it declares none or one an instance does not
 * draw (beyond `CATALOG_INDEX_LIMITS.icon`, not a path's data): a malformed icon drops the
 * icon, never the entry. A colour that is not `#RRGGBB` drops the colour alone.
 */
export function catalogMarkOf(entry: {
  readonly icon?: unknown;
  readonly iconColor?: unknown;
}): CatalogMark | null {
  const { icon, iconColor } = entry;
  if (
    typeof icon !== 'string' ||
    icon.length > CATALOG_INDEX_LIMITS.icon ||
    !SVG_PATH_DATA.test(icon)
  ) {
    return null;
  }
  return {
    path: icon,
    color: typeof iconColor === 'string' && HEX_COLOUR.test(iconColor) ? iconColor : null,
  };
}

/** Whether `x` is one entry of the index. */
export function isCatalogIndexEntry(x: unknown): x is CatalogIndexEntry {
  if (!isRecord(x)) return false;
  const { name, version, sha256 } = x;
  return (
    typeof name === 'string' &&
    name.trim() !== '' &&
    name.length <= CATALOG_INDEX_LIMITS.name &&
    typeof version === 'string' &&
    version.length <= CATALOG_INDEX_LIMITS.short &&
    // nosemgrep: detect-redos -- the length is capped just above; the pattern is semver's
    SEMVER.test(version) &&
    typeof sha256 === 'string' &&
    SHA256.test(sha256)
  );
}

/**
 * Whether `x` is an index this instance reads: schema 1, within `CATALOG_INDEX_LIMITS`.
 * Unknown extra fields are allowed; one malformed entry refuses the whole index.
 */
export function isCatalogIndex(x: unknown): x is CatalogIndex {
  if (!isRecord(x) || x['schema'] !== CATALOG_INDEX_SCHEMA) return false;
  const generatedAt = x['generated_at'];
  if (
    typeof generatedAt !== 'string' ||
    generatedAt.length > CATALOG_INDEX_LIMITS.short ||
    Number.isNaN(Date.parse(generatedAt))
  ) {
    return false;
  }
  const plugins = x['plugins'];
  if (!isRecord(plugins)) return false;
  const entries = Object.entries(plugins);
  if (entries.length > CATALOG_INDEX_LIMITS.plugins) return false;
  return entries.every(
    ([id, entry]) => PLUGIN_ID.test(id) && id.length <= 64 && isCatalogIndexEntry(entry),
  );
}
