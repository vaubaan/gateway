/**
 * A slice's path read against the plugin's data model (risk-model spec §2,
 * §3) :
 *
 *   - the path is rooted at a declared entity (any entity : a slice usually
 *     starts at the resource, below an `account` it does not name) ;
 *   - each following name is a child of the entity before it, or any
 *     descendant after `[**]` ;
 *   - the last name may instead be a **virtual leaf**, an act rather than an
 *     entity (`branch[main].merge-into`, spec §2.1) : nothing follows it but
 *     an identifier ;
 *   - each identifier follows a name, one at a time ;
 *   - for a slice a classifier emits, each named entity in a cardinality it
 *     declares : `[x]` or no identifier `one`, `[a,b]` `bounded`, `[*]`
 *     `unbounded` (plugins/README.md, step 2).
 *
 * Without it a slice naming an undeclared entity is accepted and falls to the
 * fallback, and a catalog pattern with a typo matches nothing, silently.
 * `definePlugin` runs it on every catalog pattern (`'pattern'`), the test
 * kit on every sample slice (`'slice'`, `assertSlicesOnDataModel`).
 */

import { parseSlice } from '@vaubaan/policy-engine';
import type {
  DataModel,
  DataModelCardinality,
  DataModelEntity,
  Slice,
  SliceSegment,
} from '@vaubaan/shared';

import type { ProviderPlugin } from './plugin.ts';

/**
 * `'pattern'` — a catalog `matches` pattern : `[*]` stands for one identifier,
 * `[**]` and `**` for anything below. `'slice'` — what `classify` emits : no
 * `[**]`, and the cardinality of each identifier checked (`[x]` or no
 * identifier : `one` ; `[a,b]` : `bounded` ; `[*]` : `unbounded`).
 */
export type SlicePathMode = 'pattern' | 'slice';

export interface SlicePathOptions {
  /**
   * In `'slice'` mode, check each identifier against the entity's declared
   * cardinalities. Default true. Off for a model whose cardinalities say how
   * many instances exist rather than how a slice names them (risk-model spec
   * §2.1 calls them documentary).
   */
  readonly cardinalities?: boolean;
}

/**
 * Where a walk can be : at the provider (before any entity), at one of these
 * entities, or past a virtual leaf (its name).
 */
type Position =
  readonly DataModelEntity[] | 'provider' | { readonly leaf: string; readonly under: string };

/** The first issue of `slice`'s path on `model`, or `null` when the path is one of the model. */
export function slicePathIssue(
  model: DataModel,
  slice: Slice,
  mode: SlicePathMode,
  options: SlicePathOptions = {},
): string | null {
  const cardinalities = mode === 'slice' && (options.cardinalities ?? true);
  const entities = model.planes.flatMap((plane) => plane.entities);
  let at: Position = 'provider';
  let afterAnything = false;
  let identified = false;
  for (const segment of slice.path) {
    if (segment.kind === 'wild-rec') {
      if (mode === 'slice') return "'[**]' in a slice : a classifier names what a call touches";
      afterAnything = true;
      continue;
    }
    if (segment.kind === 'name') {
      if (isLeaf(at)) {
        return `'${at.leaf}' is not below '${at.under}' in the data model, and a virtual leaf ends the path`;
      }
      if (cardinalities && isEntities(at) && !identified) {
        const issue = cardinalityIssue(at, 'one');
        if (issue) return issue;
      }
      const next = entitiesNamed(entities, at, segment.value, afterAnything);
      if (next.length === 0) {
        if (at === 'provider') return `'${segment.value}' is not an entity of the data model`;
        // A virtual leaf one or two letters away from an entity is a typo of it.
        const near = nearestEntity(entities, segment.value);
        if (near)
          return `'${segment.value}' is not below '${at[0]!.name}' : did you mean '${near}' ?`;
        at = { leaf: segment.value, under: at[0]!.name };
      } else at = next;
      afterAnything = false;
      identified = false;
      continue;
    }
    if (afterAnything) continue;
    if (at === 'provider') return `identifier '${render(segment)}' before any entity`;
    const name = isLeaf(at) ? at.leaf : at[0]!.name;
    if (identified) return `two identifiers in a row after '${name}'`;
    if (cardinalities && isEntities(at)) {
      const issue = cardinalityIssue(at, cardinalityOf(segment));
      if (issue) return issue;
    }
    identified = true;
  }
  if (cardinalities && isEntities(at) && !identified) return cardinalityIssue(at, 'one');
  return null;
}

/** Leaves shorter than this are never read as a typo : `pr` and `pi` are two words. */
const TYPO_MIN_LENGTH = 4;
/** Edits that make a leaf a typo of an entity : a swap is two. */
const TYPO_MAX_DISTANCE = 2;

/** The declared entity `name` is a typo of, if any. */
function nearestEntity(entities: readonly DataModelEntity[], name: string): string | null {
  if (name.length < TYPO_MIN_LENGTH || entities.some((e) => e.name === name)) return null;
  const near = entities.find((e) => {
    if (e.name.length < TYPO_MIN_LENGTH) return false;
    return editDistance(e.name, name) <= TYPO_MAX_DISTANCE;
  });
  return near?.name ?? null;
}

/** Levenshtein distance, two rows. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length]!;
}

function isLeaf(at: Position): at is { readonly leaf: string; readonly under: string } {
  return typeof at === 'object' && 'leaf' in at;
}

function isEntities(at: Position): at is readonly DataModelEntity[] {
  return Array.isArray(at);
}

/**
 * The entities named `name` that may follow `at` : any entity at the start
 * of the path, a child of `at`, or any descendant of it after `[**]`.
 */
function entitiesNamed(
  entities: readonly DataModelEntity[],
  at: readonly DataModelEntity[] | 'provider',
  name: string,
  afterAnything: boolean,
): DataModelEntity[] {
  const named = entities.filter((e) => e.name === name);
  if (at === 'provider') return named;
  const parents = new Set(at.map((e) => e.name));
  return named.filter((e) =>
    afterAnything
      ? hasAncestorIn(entities, e, parents)
      : e.parent !== null && parents.has(e.parent),
  );
}

function hasAncestorIn(
  entities: readonly DataModelEntity[],
  entity: DataModelEntity,
  names: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>();
  let parent = entity.parent;
  while (parent !== null && !seen.has(parent)) {
    if (names.has(parent)) return true;
    seen.add(parent);
    parent = entities.find((e) => e.name === parent)?.parent ?? null;
  }
  return false;
}

function cardinalityOf(
  segment: Exclude<SliceSegment, { kind: 'name' | 'wild-rec' }>,
): DataModelCardinality {
  if (segment.kind === 'list') return 'bounded';
  if (segment.kind === 'wild-one') return 'unbounded';
  return 'one';
}

function cardinalityIssue(
  at: readonly DataModelEntity[],
  wanted: DataModelCardinality,
): string | null {
  if (at.some((e) => e.cardinalities.includes(wanted))) return null;
  const entity = at[0]!;
  const how =
    wanted === 'one' ? 'one identifier, or none' : wanted === 'bounded' ? 'a list' : '[*]';
  return `'${entity.name}' is named by ${how}, but declares only ${entity.cardinalities.join(', ')}`;
}

function render(segment: SliceSegment): string {
  switch (segment.kind) {
    case 'ident':
    case 'name':
      return segment.value;
    case 'list':
      return segment.values.join(',');
    case 'wild-one':
      return '*';
    case 'wild-rec':
      return '**';
  }
}

/**
 * Every live catalog pattern (deprecated entries excepted : their patterns
 * are kept for the id, not maintained) whose entity path is not one of the
 * plugin's data model, as `risks[i] '<id>' matches '<pattern>': <issue>`.
 */
export function catalogPathIssues(plugin: Pick<ProviderPlugin, 'catalog' | 'dataModel'>): string[] {
  const issues: string[] = [];
  plugin.catalog.risks.forEach((risk, i) => {
    if (risk.deprecated === true) return;
    for (const pattern of [risk.matches].flat()) {
      let issue: string | null;
      try {
        issue = slicePathIssue(plugin.dataModel, parseSlice(pattern), 'pattern');
      } catch {
        continue; // Not a pattern at all : the catalog rules report it.
      }
      if (issue) issues.push(`risks[${i}] '${risk.id}' matches '${pattern}': ${issue}`);
    }
  });
  return issues;
}
