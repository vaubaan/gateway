/**
 * The provider reference of the web interface (spec §4.2 "Providers"): what
 * each shipped plugin connects to, its data model, its risk catalog, its
 * tools and its presets fully expanded.
 *
 * Everything here is a read-only projection of the plugin registry — the
 * single provider list. Nothing is written per provider: a plugin added to
 * the registry has its page, a catalog entry added to a plugin has its card.
 * Pure: no IO, no store, no credential; the pages add the session and the
 * community validation status.
 */
import { parseSlice } from '@vaubaan/policy-engine';
import type { PluginRegistry, RegisteredPlugin, TokenHandout } from '@vaubaan/plugin-sdk';
import type {
  CredentialKind,
  DataModel,
  DataModelCardinality,
  DataModelEntity,
  Gate,
  McpToolDeclaration,
  Preset,
  RateLimit,
  RiskEntry,
  RiskId,
  Slice,
  SliceSegment,
} from '@vaubaan/shared';
import { parseRiskId } from '@vaubaan/shared/risk-id';

import {
  enumerateCatalog,
  groupVariants,
  patternsOf,
  RISK_KIND_GROUPS,
  type RiskFamily,
} from '../missions/catalog-view';
import { RISK_KINDS, type CatalogRisk, type RiskKind } from '../missions/model';
import { expandPreset } from '../missions/preview';
import { presetAnchor, riskAnchor } from './links';
import { hasSeveralPlanes, OTHER_PLANE, planesOfPatterns, planesOfToolName } from './planes';

// ─────────────────────────────────────────────────────────────────────────────
// The index: one card per shipped plugin
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderCounts {
  /** Catalog entries (the fallback included). */
  readonly risks: number;
  /** Explicit ids: an env-scoped entry counts once per environment. */
  readonly risk_ids: number;
  readonly presets: number;
  readonly tools: number;
}

export interface ProviderCard {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** One line: what it connects to. */
  readonly description: string | null;
  readonly experimental: boolean;
  readonly credential_kind: CredentialKind;
  readonly counts: ProviderCounts;
  /** The planes of the data model, declaration order (`db`, `storage`, …). */
  readonly plane_slugs: readonly string[];
  /** Every environment an entry of the catalog can be accepted in, catalog order. */
  readonly envs: readonly string[];
}

function countsOf({ plugin }: RegisteredPlugin, risks: readonly CatalogRisk[]): ProviderCounts {
  return {
    risks: plugin.catalog.risks.length,
    risk_ids: risks.length,
    presets: plugin.catalog.presets?.length ?? 0,
    tools: plugin.tools.length,
  };
}

/** Every environment the catalog names, in the order it first names them. */
function catalogEnvs(entries: readonly RiskEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.acceptable_in_envs ?? []))];
}

function cardOf(registered: RegisteredPlugin, risks: readonly CatalogRisk[]): ProviderCard {
  const { plugin } = registered;
  return {
    id: plugin.id,
    name: plugin.displayName,
    version: plugin.version,
    description: plugin.description ?? null,
    experimental: plugin.experimental === true,
    credential_kind: plugin.credential.kind,
    counts: countsOf(registered, risks),
    plane_slugs: plugin.dataModel.planes.map((plane) => plane.slug),
    envs: catalogEnvs(plugin.catalog.risks),
  };
}

/** The shipped plugins, registration order: stable ones first, experimental ones last. */
export function providerCards(registry: PluginRegistry): ProviderCard[] {
  const cards = registry
    .all()
    .map((registered) => cardOf(registered, enumerateCatalog(registered.plugin.catalog)));
  return [...cards.filter((c) => !c.experimental), ...cards.filter((c) => c.experimental)];
}

// ─────────────────────────────────────────────────────────────────────────────
// The data model as a tree
// ─────────────────────────────────────────────────────────────────────────────

/** How a cardinality reads (risk model §2.1). */
export const CARDINALITY_WORDS: Readonly<Record<DataModelCardinality, string>> = {
  one: 'exactly one, named',
  bounded: 'a finite, known set',
  unbounded: 'an unknown number, possibly all',
};

export interface EntityNode {
  readonly name: string;
  readonly description: string;
  readonly cardinalities: readonly DataModelCardinality[];
  /** This entity carries the provider's environment (risk model §2.3). */
  readonly carries_env: boolean;
  readonly children: readonly EntityNode[];
}

export interface PlaneTree {
  readonly slug: string;
  readonly description: string | null;
  readonly roots: readonly EntityNode[];
  readonly entity_count: number;
}

function nodeOf(entity: DataModelEntity, all: readonly DataModelEntity[]): EntityNode {
  return {
    name: entity.name,
    description: entity.description,
    cardinalities: entity.cardinalities,
    carries_env: entity.envScopable === true,
    children: all.filter((e) => e.parent === entity.name).map((child) => nodeOf(child, all)),
  };
}

/** Each plane as a containment tree, declaration order kept among siblings. */
export function dataModelTrees(model: DataModel): PlaneTree[] {
  return model.planes.map((plane) => ({
    slug: plane.slug,
    description: plane.description ?? null,
    roots: plane.entities
      .filter((entity) => entity.parent === null)
      .map((entity) => nodeOf(entity, plane.entities)),
    entity_count: plane.entities.length,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// The environment: who carries it, where a call gets it from
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the environment of a call comes from (risk model §6): the call itself
 * (the plugin derives it), the label the connection owner puts on the
 * resource, or nowhere because no risk of the catalog depends on it.
 */
export type EnvironmentSource = 'call' | 'resource-label' | 'none';

export interface EnvironmentReference {
  readonly source: EnvironmentSource;
  /** Every environment an entry of the catalog can be accepted in, catalog order. */
  readonly envs: readonly string[];
  /** `plane.entity` of each entity the data model marks as the carrier. */
  readonly carriers: readonly string[];
  /** The rule in one or two sentences. */
  readonly explanation: string;
}

const ENVIRONMENT_EXPLANATIONS: Readonly<Record<EnvironmentSource, string>> = {
  call: 'The environment is read from each call: the plugin derives it from what the call names, whatever label the resource carries. A permission tied to an environment is held once per environment, and a call counts against the one it touches.',
  'resource-label':
    'The environment is the label the owner of the account puts on each resource. A permission tied to an environment is held once per label, and is refused on a resource that has no label or a label the permission does not list.',
  none: 'No permission of this service depends on an environment: each is held once, whatever the resource.',
};

function environmentOf({ plugin }: RegisteredPlugin): EnvironmentReference {
  const envs = catalogEnvs(plugin.catalog.risks);
  const source: EnvironmentSource =
    envs.length === 0 ? 'none' : plugin.envOf ? 'call' : 'resource-label';
  return {
    source,
    envs,
    carriers: plugin.dataModel.planes.flatMap((plane) =>
      plane.entities.filter((e) => e.envScopable === true).map((e) => `${plane.slug}.${e.name}`),
    ),
    explanation: ENVIRONMENT_EXPLANATIONS[source],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A slice pattern in plain words
// ─────────────────────────────────────────────────────────────────────────────

function qualifierWords(segment: Exclude<SliceSegment, { kind: 'name' }>): string {
  switch (segment.kind) {
    case 'wild-one':
      return 'any one';
    case 'wild-rec':
      return 'any';
    case 'ident':
      return segment.value;
    case 'list':
      return segment.values.join(', ');
  }
}

/** `repo[**].branch[main,master].file[**]` → `repo (any) › branch (main, master) › file (any)`. */
function pathWords(path: Slice['path']): string {
  const parts: string[] = [];
  for (const segment of path) {
    if (segment.kind === 'name') {
      parts.push(segment.value);
      continue;
    }
    const words = qualifierWords(segment);
    const last = parts.length - 1;
    // A qualifier follows the name it qualifies; one with no name before it stands alone.
    if (last >= 0 && !parts[last]?.endsWith(')')) parts[last] = `${parts[last]} (${words})`;
    else parts.push(segment.kind === 'wild-rec' ? 'anything below' : `(${words})`);
  }
  return parts.join(' › ');
}

/**
 * What a catalog pattern matches, in words: the action, then the path over
 * the data model with each identifier in parentheses. A mechanical reading of
 * the pattern — nothing is added that the pattern does not say. A pattern that
 * does not parse is returned as it is written.
 */
export function describePattern(pattern: string): string {
  let slice: Slice;
  try {
    slice = parseSlice(pattern);
  } catch {
    return pattern;
  }
  const action = slice.action === 'R' ? 'Read' : 'Write';
  const [only] = slice.path;
  if (slice.path.length === 1 && only?.kind === 'wild-rec') {
    return `${action} anything in ${slice.provider}`;
  }
  return `${action}: ${pathWords(slice.path)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The risk catalog
// ─────────────────────────────────────────────────────────────────────────────

export interface PatternReference {
  /** The slice pattern as the catalog writes it. */
  readonly pattern: string;
  readonly words: string;
}

/** One catalog entry: what a human reads before accepting it. */
export interface RiskReference extends RiskFamily {
  readonly anchor: string;
  /** The kind of its most severe variant: where the entry is listed. */
  readonly kind: RiskKind;
  /** Accepted per environment (`acceptable_in_envs`), or once for the account. */
  readonly env_scoped: boolean;
  readonly envs: readonly string[];
  /** True when at least one environment changes an axis of the vector. */
  readonly vector_varies: boolean;
  readonly patterns: readonly PatternReference[];
  readonly replaced_by: RiskId | null;
  readonly rate_ceiling_per_minute: number | null;
  /** Touched by a tool that hands the agent a provider token (`ProviderPlugin.tokenHandouts`). */
  readonly hands_token: boolean;
  /**
   * What the handed token can do at the provider: `read-only` when the plugin declares
   * it so (`readOnlyRiskIds`), `write` otherwise; `null` when the risk hands no token.
   * A preset gates a `write` one by approval (spec §2.4).
   */
  readonly token_access: TokenAccess | null;
  /** The tools the plugin declares as touching this risk (`tokenHandouts`); usually none. */
  readonly declared_tools: readonly string[];
  /** The planes of the data model its patterns reach (`planes.ts`); `['other']` when none. */
  readonly planes: readonly string[];
  /** The presets that include it, wholly or in some environment, catalog order. */
  readonly presets: readonly PresetTag[];
}

/** A preset as a risk names it: enough to print its tag and link to it. */
export interface PresetTag {
  readonly id: string;
  readonly label: string;
  readonly anchor: string;
}

export interface RiskReferenceGroup {
  readonly kind: RiskKind;
  readonly title: string;
  readonly hint: string;
  readonly entries: readonly RiskReference[];
}

/** What an entry is read against, besides itself: the model, the handouts, the presets. */
interface CatalogContext {
  readonly model: DataModel;
  readonly handouts: readonly TokenHandout[];
  readonly presets: readonly PresetReference[];
}

function worstKind(variants: readonly CatalogRisk[]): RiskKind {
  const ranks = variants.map((risk) => RISK_KINDS.indexOf(risk.kind));
  return RISK_KINDS[Math.max(0, ...ranks)] ?? 'write';
}

function riskReferenceOf(
  entry: RiskEntry,
  family: RiskFamily,
  context: CatalogContext,
): RiskReference {
  const handing = context.handouts.filter((handout) => handout.riskIds.includes(entry.id));
  const tools = handing.map((handout) => handout.tool);
  // Write as soon as one tool that touches it does not declare it read-only.
  const readOnly = handing.every((handout) => handout.readOnlyRiskIds?.includes(entry.id));
  return {
    hands_token: tools.length > 0,
    token_access: tools.length === 0 ? null : readOnly ? 'read-only' : 'write',
    declared_tools: tools,
    planes: planesOfPatterns(context.model, patternsOf(entry)),
    presets: context.presets
      .filter((preset) =>
        [...preset.auto, ...preset.approval].some((line) => line.risk.base_id === entry.id),
      )
      .map(({ id, label, anchor }) => ({ id, label, anchor })),
    ...family,
    anchor: riskAnchor(entry.id),
    kind: worstKind(family.variants),
    env_scoped: family.variants.some((risk) => risk.env !== null),
    envs: family.variants.flatMap((risk) => (risk.env === null ? [] : [risk.env])),
    vector_varies: Object.keys(entry.vector_overrides ?? {}).length > 0,
    patterns: patternsOf(entry).map((pattern) => ({ pattern, words: describePattern(pattern) })),
    replaced_by: entry.replaced_by ?? null,
    rate_ceiling_per_minute: entry.infra_limits?.calls_per_minute_max ?? null,
  };
}

/**
 * The catalog as the reference lists it: reads, writes, irreversible writes.
 * Unlike the editor's `groupByKind`, an entry is never split: it is listed
 * once, under the kind of its most severe variant, so its anchor is unique.
 */
function riskGroupsOf(
  entries: readonly RiskEntry[],
  risks: readonly CatalogRisk[],
  context: CatalogContext,
): RiskReferenceGroup[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const references = groupVariants(risks).flatMap((family) => {
    const entry = byId.get(family.base_id);
    return entry ? [riskReferenceOf(entry, family, context)] : [];
  });
  return RISK_KINDS.map((kind) => ({
    kind,
    ...RISK_KIND_GROUPS[kind],
    entries: references.filter((reference) => reference.kind === kind),
  })).filter((group) => group.entries.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Presets, fully expanded
// ─────────────────────────────────────────────────────────────────────────────

/** One explicit line a preset contributes: the risk with its budget and gate. */
export interface PresetLine {
  readonly risk: CatalogRisk;
  readonly quota: number;
  readonly rate_limit: RateLimit;
  readonly gate: Gate;
}

export interface PresetReference {
  readonly id: string;
  readonly anchor: string;
  readonly label: string;
  readonly description: string;
  /** Lines the agent may act on without asking, catalog order. */
  readonly auto: readonly PresetLine[];
  /** Lines where each action waits for the creator's approval. */
  readonly approval: readonly PresetLine[];
  /** Catalog entries the preset leaves out, wholly or in some environments. */
  readonly not_included: readonly RiskFamily[];
}

/**
 * A preset against the whole catalog: an entry naming the base id of an
 * env-scoped risk stands for that risk in every environment the catalog
 * lists, exactly as issuance expands it when every environment is reachable.
 * What a mission gets is this list bounded by the creator's authority and by
 * the resources selected.
 */
export function presetReferenceOf(preset: Preset, risks: readonly CatalogRisk[]): PresetReference {
  const { lines } = expandPreset(preset, { risks, derives_env: true }, []);
  const byId = new Map(lines.map((line) => [line.risk_id, line]));
  const included = risks.flatMap((risk): PresetLine[] => {
    const line = byId.get(risk.risk_id);
    return line ? [{ risk, quota: line.quota, rate_limit: line.rate_limit, gate: line.gate }] : [];
  });
  return {
    id: preset.id,
    anchor: presetAnchor(preset.id),
    label: preset.label,
    description: preset.description,
    auto: included.filter((line) => line.gate === 'auto'),
    approval: included.filter((line) => line.gate === 'approval'),
    not_included: groupVariants(risks.filter((risk) => !byId.has(risk.risk_id))),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolReference {
  readonly name: string;
  readonly description: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  /**
   * The risks the plugin declares for this tool, when it declares any
   * (`tokenHandouts`): the only static tool-to-risk statement a plugin
   * makes. `null` otherwise — the risks depend on the arguments.
   */
  readonly declared_risks: readonly RiskId[] | null;
  /** The tool returns a short-lived provider token to the agent (spec §2.4). */
  readonly hands_token: boolean;
  /** The plane its name files it under (`planes.ts`); `['other']` when the name says none. */
  readonly planes: readonly string[];
}

function toolReferenceOf(
  tool: McpToolDeclaration,
  handouts: readonly TokenHandout[],
  model: DataModel,
): ToolReference {
  const required = tool.inputSchema.required ?? [];
  const handout = handouts.find((h) => h.tool === tool.name);
  return {
    declared_risks: handout ? handout.riskIds : null,
    hands_token: handout !== undefined,
    planes: planesOfToolName(model, tool.name),
    name: tool.name,
    description: tool.description,
    required,
    optional: Object.keys(tool.inputSchema.properties ?? {}).filter(
      (name) => !required.includes(name),
    ),
  };
}

/**
 * Why the reference does not say which risks a tool touches: the plugin
 * classifies a call from its arguments (the branch written, the environment
 * named, one row or all of them), and declares no static tool-to-risk table.
 * The page says so instead of guessing.
 */
export const TOOL_RISKS_NOTE =
  'Which permissions a call needs depends on its arguments: the same tool can need a mild one on one resource and a severe one on another, and the plugin decides call by call. A plugin declares no table of the permissions of each tool, so none is shown here; the list of permissions is the complete list of what any call can need. For the same reason an agent is listed every tool of the services its mission uses, and a listed tool can still be refused when it is called: what a given mission can call is answered precisely by the catalog endpoint of the execution door, not by the tool list.';

/** What the mark "hands a token to the agent" means (spec §2.4). */
export const TOKEN_HANDOUT_NOTE =
  'Hands a token to the agent: the one deliberate exception to "the agent never sees a credential of the service". The tool returns a short-lived, narrowly scoped token of the service, because the work cannot go through the gateway (git clone, git push). What the agent then does with that token is outside the gateway: it is not classified, not counted and not recorded. The call that obtains the token is: it is a permission of its own, never included by default, counted against its limit and recorded. In a preset, a token that can write is handed only after the creator approves the call; a read-only token may be handed without asking. The long-lived credential never leaves the gateway.';

/** What a handed token can do at the provider. */
export type TokenAccess = 'read-only' | 'write';

/** The badge of a risk that hands a token: what the token can do, in three words. */
export const TOKEN_ACCESS_BADGE: Readonly<Record<TokenAccess, string>> = {
  'read-only': 'hands a read-only token',
  write: 'hands a write token',
};

// ─────────────────────────────────────────────────────────────────────────────
// The whole page
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderReference extends ProviderCard {
  /** The plain-words paragraph (`ProviderPlugin.summary`); `null` when the plugin ships none. */
  readonly summary: string | null;
  readonly docs_url: string | null;
  readonly catalog_version: number | null;
  readonly catalog_date: string | null;
  readonly planes: readonly PlaneTree[];
  /**
   * The planes a reader can slice the page by, with what each holds; empty
   * when the model has one plane only (no plane control is then shown).
   * `other` comes last, and only when something is filed there.
   */
  readonly plane_filters: readonly PlaneFilter[];
  readonly environment: EnvironmentReference;
  readonly risk_groups: readonly RiskReferenceGroup[];
  readonly presets: readonly PresetReference[];
  readonly tools: readonly ToolReference[];
}

export interface PlaneFilter {
  readonly slug: string;
  readonly description: string | null;
  /** Catalog entries and tools filed under this plane. */
  readonly risks: number;
  readonly tools: number;
}

/** How the page explains the `other` plane, and how tools are filed. */
export const OTHER_PLANE_NOTE =
  'The parts of a service: a permission is filed under the part of the first thing its pattern names that one part alone declares. A tool declares no pattern: it is filed under a part only when its name contains the name of such a thing. Whatever names none — a permission over the whole service, a tool whose name says nothing — is under "other" rather than guessed.';

function planeFiltersOf(
  model: DataModel,
  groups: readonly RiskReferenceGroup[],
  tools: readonly ToolReference[],
): PlaneFilter[] {
  if (!hasSeveralPlanes(model)) return [];
  const entries = groups.flatMap((group) => group.entries);
  const filterOf = (slug: string, description: string | null): PlaneFilter => ({
    slug,
    description,
    risks: entries.filter((entry) => entry.planes.includes(slug)).length,
    tools: tools.filter((tool) => tool.planes.includes(slug)).length,
  });
  const other = filterOf(OTHER_PLANE, null);
  return [
    ...model.planes.map((plane) => filterOf(plane.slug, plane.description ?? null)),
    ...(other.risks + other.tools > 0 ? [other] : []),
  ];
}

export function providerReferenceOf(registered: RegisteredPlugin): ProviderReference {
  const { plugin } = registered;
  const risks = enumerateCatalog(plugin.catalog);
  const handouts = plugin.tokenHandouts ?? [];
  const model = plugin.dataModel;
  const presets = (plugin.catalog.presets ?? []).map((preset) => presetReferenceOf(preset, risks));
  const riskGroups = riskGroupsOf(plugin.catalog.risks, risks, { model, handouts, presets });
  const tools = plugin.tools.map((tool) => toolReferenceOf(tool, handouts, model));
  return {
    ...cardOf(registered, risks),
    summary: plugin.summary ?? null,
    docs_url: plugin.docsUrl ?? null,
    catalog_version: plugin.catalog.catalog_version ?? null,
    catalog_date: plugin.catalog.catalog_date ?? null,
    planes: dataModelTrees(model),
    plane_filters: planeFiltersOf(model, riskGroups, tools),
    environment: environmentOf(registered),
    risk_groups: riskGroups,
    presets,
    tools,
  };
}

/** The reference of one provider, or `null` when no plugin has that id. */
export function providerReference(
  registry: PluginRegistry,
  providerId: string,
): ProviderReference | null {
  const registered = registry.get(providerId);
  return registered ? providerReferenceOf(registered) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Explaining the risks of an existing policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Looks up the catalog row of any explicit risk id, for the pages that list a
 * persisted policy (a mission, a share). Each provider's catalog is enumerated
 * once. `null` for an id no shipped catalog declares: the page then shows the
 * bare id.
 */
export function riskExplainer(registry: PluginRegistry): (riskId: RiskId) => CatalogRisk | null {
  const cache = new Map<string, ReadonlyMap<RiskId, CatalogRisk>>();
  return (riskId) => {
    const provider = parseRiskId(riskId)?.provider;
    if (!provider) return null;
    let rows = cache.get(provider);
    if (!rows) {
      const registered = registry.get(provider);
      rows = new Map(
        (registered ? enumerateCatalog(registered.plugin.catalog) : []).map((risk) => [
          risk.risk_id,
          risk,
        ]),
      );
      cache.set(provider, rows);
    }
    return rows.get(riskId) ?? null;
  };
}
