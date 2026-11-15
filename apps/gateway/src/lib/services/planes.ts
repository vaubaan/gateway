/**
 * Which plane of a service's data model a risk or a tool belongs to (risk
 * model §2 "the data model per plane"). A service with several planes
 * (Supabase: `db`, `storage`, `auth`, `functions`) is read plane by plane in
 * the reference and in the Custom editor; a service with one plane has no
 * plane control at all.
 *
 * Nothing is declared per risk or per tool, so the plane is read from what is
 * declared, and what cannot be read is filed under `OTHER_PLANE`, never
 * guessed:
 *
 *  - a **risk** belongs to the plane of the first entity of its pattern that
 *    one plane alone declares (`project` is the root of every Supabase plane
 *    and decides nothing; `bucket` is `storage`'s). A pattern that names no
 *    such entity — `supabase.**.R` — has no single plane;
 *  - a **tool** declares no pattern (a call is classified from its
 *    arguments). It is filed under a plane only when its name contains the
 *    name of an entity that one plane alone declares
 *    (`supabase__list_buckets` → `bucket` → `storage`); the longest entity
 *    name wins, and two planes at that length mean no plane.
 *
 * Pure and browser-safe: values come from `@vaubaan/policy-engine` only.
 */
import { parseSlice } from '@vaubaan/policy-engine';
import type { DataModel, RiskCatalog, RiskId } from '@vaubaan/shared';

/** Where the entries go whose plane cannot be read from the data. */
export const OTHER_PLANE = 'other';

/** Entity name → the one plane that declares it; an entity several planes declare is absent. */
function ownersOf(model: DataModel): ReadonlyMap<string, string> {
  const planes = new Map<string, Set<string>>();
  for (const plane of model.planes) {
    for (const entity of plane.entities) {
      const set = planes.get(entity.name) ?? new Set<string>();
      set.add(plane.slug);
      planes.set(entity.name, set);
    }
  }
  const owners = new Map<string, string>();
  for (const [entity, set] of planes) {
    const [only] = set;
    if (set.size === 1 && only !== undefined) owners.set(entity, only);
  }
  return owners;
}

/** True when the plane is worth a control: the model declares more than one. */
export function hasSeveralPlanes(model: DataModel): boolean {
  return model.planes.length > 1;
}

function planeOfPattern(pattern: string, owners: ReadonlyMap<string, string>): string | null {
  let names: string[];
  try {
    names = parseSlice(pattern).path.flatMap((segment) =>
      segment.kind === 'name' ? [segment.value] : [],
    );
  } catch {
    return null;
  }
  for (const name of names) {
    const owner = owners.get(name);
    if (owner !== undefined) return owner;
  }
  return null;
}

/**
 * The planes the patterns of one catalog entry reach, model order;
 * `[OTHER_PLANE]` when no pattern names an entity of a single plane.
 */
export function planesOfPatterns(model: DataModel, patterns: readonly string[]): string[] {
  const owners = ownersOf(model);
  const found = new Set(
    patterns.flatMap((pattern) => {
      const plane = planeOfPattern(pattern, owners);
      return plane === null ? [] : [plane];
    }),
  );
  if (found.size === 0) return [OTHER_PLANE];
  return model.planes.map((plane) => plane.slug).filter((slug) => found.has(slug));
}

/** `sso_providers` and `sso-provider` compare equal: lower case, no plural `s`. */
function words(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word));
}

function contains(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

/**
 * The plane a tool is filed under, from its name alone (see the file header);
 * `[OTHER_PLANE]` when the name contains no entity of a single plane, or
 * entities of two planes at the same length.
 */
export function planesOfToolName(model: DataModel, toolName: string): string[] {
  // `supabase__list_buckets`: the service prefix says nothing about the plane.
  const name = words(
    toolName.includes('__') ? toolName.slice(toolName.indexOf('__') + 2) : toolName,
  );
  let longest = 0;
  let planes = new Set<string>();
  for (const [entity, owner] of ownersOf(model)) {
    const entityWords = words(entity);
    if (!contains(name, entityWords)) continue;
    if (entityWords.length > longest) {
      longest = entityWords.length;
      planes = new Set([owner]);
    } else if (entityWords.length === longest) {
      planes.add(owner);
    }
  }
  const [only] = planes;
  return planes.size === 1 && only !== undefined ? [only] : [OTHER_PLANE];
}

/** What the Custom editor needs to offer the plane filter of one service. */
export interface RiskPlanes {
  /** The planes that hold at least one risk, model order, `OTHER_PLANE` last. */
  readonly planes: readonly string[];
  /** Catalog entry id → its planes. */
  readonly by_risk: Readonly<Record<RiskId, readonly string[]>>;
}

/**
 * The planes of every entry of a catalog, or `null` when the model has one
 * plane only: there is then nothing to filter by.
 */
export function riskPlanesOf(model: DataModel, catalog: RiskCatalog): RiskPlanes | null {
  if (!hasSeveralPlanes(model)) return null;
  const byRisk: Record<RiskId, readonly string[]> = {};
  for (const entry of catalog.risks) {
    const patterns = typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
    byRisk[entry.id] = planesOfPatterns(model, patterns);
  }
  const used = new Set(Object.values(byRisk).flat());
  const planes = [...model.planes.map((plane) => plane.slug), OTHER_PLANE].filter((slug) =>
    used.has(slug),
  );
  return { planes, by_risk: byRisk };
}
