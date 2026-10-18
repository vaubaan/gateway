/**
 * The issuance decision, as a pure function: a draft, checked against the
 * connections the creator holds authority on, yields a preview — what passes,
 * what exceeds the authority, what cannot resolve, and whether the draft can
 * be issued as written.
 *
 * `MissionService.preview()` and `issue()` call it with the context read from
 * the store; the creation form calls it with the context the page was
 * rendered with, for instant feedback. `issue()` always recomputes it
 * server-side: the browser's copy decides nothing.
 *
 * Spec §3.1 (monotonicity, enumeration, partition per connection, resource
 * selection), §3.2 (mandatory budget, presets), §0 "Resource" (env-qualified
 * ids resolve against the selected resources). Browser-safe: no IO.
 */
import { budgetIssues, exceedsRateCeiling, type BudgetField } from '@vaubaan/policy-engine';
import type {
  Gate,
  MissionPolicyEntry,
  Preset,
  PresetEntry,
  RateLimit,
  RiskId,
} from '@vaubaan/shared';
import { GATES } from '@vaubaan/shared/domain';

// The file, not the barrel: `catalog-authority.ts` is pure and browser-safe, the barrel is not.
import { uncoveredRisks } from '../authority/catalog-authority';
import { isResolvable } from './catalog-view';
import { EVERYTHING_I_HOLD, expansionDigest, findPreset, presetIdsOf } from './everything-i-hold';
import type {
  CatalogRisk,
  ConnectionPreview,
  DraftConnection,
  DraftPeriod,
  DraftPolicyEntry,
  IssuanceConnection,
  IssuanceResource,
  MissionDraft,
  MissionPreview,
  PreviewIssue,
  PreviewNotice,
  ResolvedDraftConnection,
  SkippedPresetEntry,
  UnresolvableEntry,
} from './model';
import { summarize } from './summary';

export const MISSION_NAME_MAX_LENGTH = 120;
/** Shortest recurring period: one minute. */
export const MIN_PERIOD_SECONDS = 60;
export const MAX_PERIOD_SECONDS = 366 * 24 * 3600;
export { SECONDS_PER_MINUTE } from '@vaubaan/policy-engine';

export interface PreviewContext {
  /** Connections the creator holds a non-empty authority on. */
  readonly connections: readonly IssuanceConnection[];
  readonly now: Date;
}

/** The creator's wording of each field `budgetIssues` can reject. */
const BUDGET_PROBLEMS: Readonly<Record<BudgetField, string>> = {
  quota: 'quota must be a whole number of at least 1',
  rate_limit: 'rate limit must be a whole number of at least 1',
  'rate_limit.max': 'rate limit must be a whole number of at least 1',
  'rate_limit.window_seconds': 'rate window must be a whole number of seconds, at least 1',
  gate: `gate must be one of ${GATES.join(', ')}`,
};

/**
 * Why a budget is not acceptable, or `null`. The rule itself — a positive
 * integer quota, a positive integer rate over a positive integer window, a
 * gate of the closed set (spec §3.2) — is `budgetIssues` of
 * `@vaubaan/policy-engine`, the same function the plugin SDK's catalog loader
 * applies to a preset. Issuance adds the catalog's rate ceiling.
 */
export function budgetProblem(
  entry: { quota: number; rate_limit: RateLimit; gate: Gate },
  risk: Pick<CatalogRisk, 'rate_ceiling_per_minute'>,
): string | null {
  const [first] = budgetIssues(entry);
  if (first) return BUDGET_PROBLEMS[first.field];
  const ceiling = risk.rate_ceiling_per_minute;
  if (exceedsRateCeiling(entry.rate_limit, ceiling)) {
    return `rate limit exceeds the catalog ceiling of ${ceiling} per minute`;
  }
  return null;
}

/** The explicit entry a draft line resolves to, or `null` when its budget is missing. */
function resolveEntry(
  line: DraftPolicyEntry,
  fromPreset: PresetEntry | undefined,
): MissionPolicyEntry | null {
  const quota = line.quota ?? fromPreset?.quota;
  const rateLimit = line.rate_limit ?? fromPreset?.rate_limit;
  if (quota === undefined || rateLimit === undefined) return null;
  return {
    risk_id: line.risk_id,
    quota,
    rate_limit: { max: rateLimit.max, window_seconds: rateLimit.window_seconds },
    gate: line.gate ?? fromPreset?.gate ?? 'auto',
  };
}

interface ResourceResolution {
  readonly selected: IssuanceResource[];
  readonly issues: PreviewIssue[];
}

/**
 * What "all resources" means: not hidden by the owner, still returned by
 * discovery, and not one of the instance's own (never reachable by a mission).
 */
export function defaultResources(
  connection: Pick<IssuanceConnection, 'resources'>,
): IssuanceResource[] {
  return connection.resources.filter((r) => !r.hidden && !r.stale && !r.self);
}

/** The "M" of "N of M resources": the default set plus hidden resources picked on purpose. */
function resourcesTotal(
  connection: Pick<IssuanceConnection, 'resources'>,
  selected: readonly IssuanceResource[],
): number {
  return defaultResources(connection).length + selected.filter((r) => r.hidden).length;
}

function resolveResources(
  connection: IssuanceConnection,
  draft: DraftConnection,
  index: number,
): ResourceResolution {
  const wanted = draft.resources ?? { scope: 'all' };
  // `connection` is judged on what it reaches now; later resources join at read time.
  if (wanted.scope === 'all' || wanted.scope === 'connection') {
    return { selected: defaultResources(connection), issues: [] };
  }

  const where = { connection_index: index, connection_id: connection.id };
  const byId = new Map(connection.resources.map((r) => [r.id, r]));
  const byRef = new Map(connection.resources.map((r) => [r.ref, r]));
  const selected = new Map<string, IssuanceResource>();
  const foreign: string[] = [];
  for (const id of wanted.resource_ids ?? []) {
    const found = byId.get(id);
    if (found) selected.set(found.id, found);
    else foreign.push(id);
  }
  for (const ref of wanted.resource_refs ?? []) {
    const found = byRef.get(ref);
    if (found) selected.set(found.id, found);
    else foreign.push(ref);
  }
  const issues: PreviewIssue[] = [];
  if (foreign.length > 0) {
    issues.push({
      code: 'resource-not-in-connection',
      message: `${foreign.length === 1 ? 'Resource' : 'Resources'} ${foreign.join(', ')} ${
        foreign.length === 1 ? 'does' : 'do'
      } not belong to connection "${connection.display_name}".`,
      resource_refs: foreign,
      ...where,
    });
  }
  const stale = [...selected.values()].filter((r) => r.stale);
  if (stale.length > 0) {
    issues.push({
      code: 'resource-stale',
      message: `No longer found on "${connection.display_name}" at the provider: ${stale
        .map((r) => r.ref)
        .join(', ')}. Refresh the connection's resources or leave ${
        stale.length === 1 ? 'it' : 'them'
      } out.`,
      resource_refs: stale.map((r) => r.ref),
      ...where,
    });
    for (const r of stale) selected.delete(r.id);
  }
  // One of the instance's own resources (SEC 2026-10-15 H1): refused whoever
  // selects it, the creator's authority on the connection notwithstanding.
  const self = [...selected.values()].filter((r) => r.self);
  if (self.length > 0) {
    issues.push({
      code: 'resource-self',
      message: `${self.map((r) => r.ref).join(', ')} on "${connection.display_name}" ${
        self.length === 1 ? 'hosts' : 'host'
      } this instance: never reachable by a mission. Leave ${
        self.length === 1 ? 'it' : 'them'
      } out.`,
      resource_refs: self.map((r) => r.ref),
      ...where,
    });
    for (const r of self) selected.delete(r.id);
  }
  if (selected.size === 0 && foreign.length === 0 && stale.length === 0 && self.length === 0) {
    issues.push({
      code: 'no-resource-selected',
      message: `Connection "${connection.display_name}" has no resource selected: the mission could touch nothing on it.`,
      ...where,
    });
  }
  // Keep the connection's own order, so the persisted list is stable.
  return { selected: connection.resources.filter((r) => selected.has(r.id)), issues };
}

/**
 * The lines a preset contributes on one connection. An entry naming an
 * explicit id stands for itself. An entry naming the *base* id of an
 * env-scoped risk (`stripe.read-catalog`: "of the selected mode") stands for
 * that risk in every environment the selection can resolve, and becomes one
 * explicit line per such environment — the persisted policy never holds a
 * base id the runtime could not match.
 */
export function expandPreset(
  preset: Pick<Preset, 'entries'>,
  connection: Pick<IssuanceConnection, 'risks' | 'derives_env'>,
  selected: readonly Pick<IssuanceResource, 'env'>[],
): { readonly lines: PresetEntry[]; readonly unresolved: RiskId[] } {
  const explicit = new Set(connection.risks.map((r) => r.risk_id));
  const lines: PresetEntry[] = [];
  const unresolved: RiskId[] = [];
  for (const entry of preset.entries) {
    if (explicit.has(entry.risk_id)) {
      lines.push(entry);
      continue;
    }
    const perEnv = connection.risks.filter((r) => r.base_id === entry.risk_id && r.env !== null);
    const reachable = perEnv.filter((r) => isResolvable(r, connection, selected));
    if (perEnv.length > 0 && reachable.length === 0) {
      unresolved.push(entry.risk_id);
      continue;
    }
    // Not a base id either: left as is, the caller reports it as unknown.
    if (perEnv.length === 0) lines.push(entry);
    for (const risk of reachable) lines.push({ ...entry, risk_id: risk.risk_id });
  }
  return { lines, unresolved };
}

interface ConnectionOutcome {
  readonly preview: ConnectionPreview;
  readonly issues: PreviewIssue[];
  /** Non-blocking: what the creator should know about a selection that passes. */
  readonly notices: PreviewNotice[];
}

/** Where an issue or a notice points: the draft line and the connection it resolved to. */
interface Where {
  readonly connection_index: number;
  readonly connection_id: string;
}

function list(ids: readonly string[]): string {
  return ids.join(', ');
}

interface PresetResolution {
  readonly preset: Preset | undefined;
  /** The preset's lines on this connection, base ids expanded per reachable environment. */
  readonly lines: readonly PresetEntry[];
  /** Base ids of env-scoped risks no selected resource can resolve. */
  readonly unresolved: readonly RiskId[];
  /**
   * Budget defaults of an explicit line: the preset's entry for that id, else
   * the preset's entry for its base id ("in whatever environment").
   */
  readonly defaults: ReadonlyMap<RiskId, PresetEntry>;
  readonly issues: PreviewIssue[];
}

/** The preset a draft names on a connection, expanded against the selected resources. */
function resolvePreset(
  connection: IssuanceConnection,
  draft: DraftConnection,
  selected: readonly IssuanceResource[],
  where: Where,
): PresetResolution {
  // The built-in `everything-i-hold` is computed here, against this selection (ADR
  // preset-everything-i-hold-expands-explicitly); a plugin's preset is read as shipped.
  const preset = draft.preset ? findPreset(connection, draft.preset, selected) : undefined;
  const issues: PreviewIssue[] = [];
  if (draft.preset && !preset) {
    issues.push({
      code: 'unknown-preset',
      message: `"${draft.preset}" is not a preset of ${connection.provider_label} (known: ${list(
        presetIdsOf(connection),
      )}).`,
      ...where,
    });
  }
  const expanded = preset
    ? expandPreset(preset, connection, selected)
    : { lines: [], unresolved: [] };
  const defaults = new Map((preset?.entries ?? []).map((e) => [e.risk_id, e]));
  for (const line of expanded.lines) defaults.set(line.risk_id, line);
  return { preset, lines: expanded.lines, unresolved: expanded.unresolved, defaults, issues };
}

/** Where each line of a connection's policy ends up. */
interface LineBuckets {
  /** Accepted, inside the authority, resolvable, with a valid resolved budget. */
  readonly passes: MissionPolicyEntry[];
  readonly exceeds: RiskId[];
  readonly unknown: RiskId[];
  readonly unresolvable: UnresolvableEntry[];
  readonly missingBudget: RiskId[];
  readonly duplicates: RiskId[];
  /** Preset entries left out when the preset is applied as is. */
  readonly skipped: SkippedPresetEntry[];
  readonly invalid: { risk_id: RiskId; problem: string }[];
}

interface ClassifyInput {
  readonly connection: IssuanceConnection;
  readonly selected: readonly IssuanceResource[];
  /** The preset applied as is: what the creator does not hold or cannot resolve is skipped. */
  readonly presetOnly: boolean;
  readonly preset: Pick<PresetResolution, 'defaults' | 'unresolved'>;
}

/**
 * Sorts each line into exactly one bucket, first reason wins: duplicate,
 * unknown to the catalog, outside the authority, unresolvable environment,
 * no budget, invalid budget — otherwise it passes.
 */
function classifyLines(lines: readonly DraftPolicyEntry[], input: ClassifyInput): LineBuckets {
  const { connection, selected, presetOnly, preset } = input;
  const catalog = new Map(connection.risks.map((r) => [r.risk_id, r]));
  // Monotonicity (spec §3.1): the lines the creator's authority does not cover.
  const outside = new Set(
    uncoveredRisks(
      { riskIds: connection.authority },
      lines.map((line) => line.risk_id),
    ),
  );
  const seen = new Set<RiskId>();
  const buckets: LineBuckets = {
    passes: [],
    exceeds: [],
    unknown: [],
    unresolvable: [],
    missingBudget: [],
    duplicates: [],
    skipped: presetOnly
      ? preset.unresolved.map((risk_id) => ({ risk_id, reason: 'unresolvable-env', env: null }))
      : [],
    invalid: [],
  };

  for (const line of lines) {
    if (seen.has(line.risk_id)) {
      buckets.duplicates.push(line.risk_id);
      continue;
    }
    seen.add(line.risk_id);
    const risk = catalog.get(line.risk_id);
    if (!risk) {
      buckets.unknown.push(line.risk_id);
      continue;
    }
    if (outside.has(line.risk_id)) {
      if (presetOnly) {
        buckets.skipped.push({ risk_id: line.risk_id, reason: 'outside-authority', env: risk.env });
      } else buckets.exceeds.push(line.risk_id);
      continue;
    }
    if (!isResolvable(risk, connection, selected)) {
      if (presetOnly) {
        buckets.skipped.push({ risk_id: line.risk_id, reason: 'unresolvable-env', env: risk.env });
      } else buckets.unresolvable.push({ risk_id: line.risk_id, env: risk.env ?? '' });
      continue;
    }
    const entry = resolveEntry(
      line,
      preset.defaults.get(line.risk_id) ?? preset.defaults.get(risk.base_id),
    );
    if (!entry) {
      buckets.missingBudget.push(line.risk_id);
      continue;
    }
    const problem = budgetProblem(entry, risk);
    if (problem) {
      buckets.invalid.push({ risk_id: line.risk_id, problem });
      continue;
    }
    buckets.passes.push(entry);
  }
  return buckets;
}

/** One issue per non-empty refusing bucket, in a fixed order. */
function issuesOf(
  buckets: LineBuckets,
  connection: Pick<IssuanceConnection, 'display_name' | 'provider_label'>,
  where: Where,
): PreviewIssue[] {
  const { unknown, duplicates, exceeds, unresolvable, missingBudget, invalid } = buckets;
  const name = connection.display_name;
  const issues: PreviewIssue[] = [];
  if (unknown.length > 0) {
    issues.push({
      code: 'unknown-risk',
      message: `Not ${unknown.length === 1 ? 'a risk' : 'risks'} of the ${connection.provider_label} catalog: ${list(unknown)}. A mission policy is an explicit enumeration of catalog ids.`,
      risk_ids: unknown,
      ...where,
    });
  }
  if (duplicates.length > 0) {
    issues.push({
      code: 'duplicate-risk',
      message: `Listed more than once on "${name}": ${list(duplicates)}.`,
      risk_ids: duplicates,
      ...where,
    });
  }
  if (exceeds.length > 0) {
    issues.push({
      code: 'exceeds-authority',
      message: `Outside your authority on "${name}": ${list(exceeds)}.`,
      risk_ids: exceeds,
      ...where,
    });
  }
  if (unresolvable.length > 0) {
    const envs = [...new Set(unresolvable.map((u) => u.env))];
    issues.push({
      code: 'unresolvable-env',
      message: `No selected resource of "${name}" is labelled ${list(
        envs.map((e) => `"${e}"`),
      )}, so these entries could never be touched: ${list(unresolvable.map((u) => u.risk_id))}.`,
      risk_ids: unresolvable.map((u) => u.risk_id),
      ...where,
    });
  }
  if (missingBudget.length > 0) {
    issues.push({
      code: 'missing-budget',
      message: `No budget for ${list(missingBudget)} on "${name}": an accepted risk needs a quota and a rate limit (no infinite budget).`,
      risk_ids: missingBudget,
      ...where,
    });
  }
  for (const bad of invalid) {
    issues.push({
      code: 'invalid-budget',
      message: `${bad.risk_id}: ${bad.problem}.`,
      risk_ids: [bad.risk_id],
      ...where,
    });
  }
  return issues;
}

/**
 * What the creator is not told by an issue: a selected resource on which no
 * env-scoped risk can ever be touched. At call time an env-scoped risk
 * touched on a resource whose label is absent, or is not an environment the
 * risk is acceptable in, refuses the call (`risk-not-accepted`), whatever the
 * mission accepts. Nothing to say when the plugin derives the environment
 * from the call itself, or when the catalog has no env-scoped risk.
 *
 * The sentence names a resource as the pages do, by its display name; the
 * refs are in `resource_refs`, for whoever reads the notice as data.
 */
export function envNotices(
  connection: Pick<IssuanceConnection, 'risks' | 'derives_env' | 'display_name' | 'provider_label'>,
  selected: readonly (Pick<IssuanceResource, 'ref' | 'env'> &
    Partial<Pick<IssuanceResource, 'display_name'>>)[],
  passes: readonly Pick<MissionPolicyEntry, 'risk_id'>[],
  where: Where,
): PreviewNotice[] {
  if (connection.derives_env) return [];
  const envScoped = connection.risks.filter((r) => r.env !== null);
  if (envScoped.length === 0) return [];
  const envs = [...new Set(envScoped.flatMap((r) => (r.env === null ? [] : [r.env])))];
  const scopedIds = new Set(envScoped.map((r) => r.risk_id));
  const accepted = passes.map((p) => p.risk_id).filter((id) => scopedIds.has(id));
  const name = connection.display_name;
  const consequence = `${connection.provider_label} risks that depend on the environment can never be touched there: a call that touches one is refused (risk-not-accepted), whatever the mission accepts${
    accepted.length > 0 ? ` — including ${list(accepted)}` : ''
  }.`;
  const remedy = `Label the resource on the connection's page (${list(envs)}) or leave it out.`;
  const unlabelledRemedy = `Label the resource on the connection's page (${list(envs)}), give the connection a default environment for its unlabelled resources, or leave it out.`;

  const notices: PreviewNotice[] = [];
  const called = (r: (typeof selected)[number]): string => r.display_name || r.ref;
  const unlabelled = selected.filter((r) => r.env === null);
  if (unlabelled.length > 0) {
    notices.push({
      code: 'resource-without-env',
      message: `No environment label on ${list(unlabelled.map(called))} ("${name}"). ${consequence} ${unlabelledRemedy}`,
      resource_refs: unlabelled.map((r) => r.ref),
      risk_ids: accepted,
      ...where,
    });
  }
  const foreign = selected.filter((r) => r.env !== null && !envs.includes(r.env));
  if (foreign.length > 0) {
    notices.push({
      code: 'resource-env-not-in-catalog',
      message: `${list(foreign.map((r) => `${called(r)} (labelled "${r.env}")`))} on "${name}": no ${connection.provider_label} risk is acceptable in that environment. ${consequence} ${remedy}`,
      resource_refs: foreign.map((r) => r.ref),
      risk_ids: accepted,
      ...where,
    });
  }
  return notices;
}

/**
 * What the creator of a whole-connection selection (scope `connection`) is not
 * told by the per-resource notices: a resource discovered after issuance
 * carries no environment label until someone sets it, and env-scoped risks are
 * refused on it until then. Nothing to say when the plugin derives the
 * environment from the call, when the connection has a default environment
 * (later resources inherit it), or when the catalog has no env-scoped risk.
 */
export function laterResourcesNotice(
  connection: Pick<
    IssuanceConnection,
    'risks' | 'derives_env' | 'display_name' | 'provider_label' | 'default_env'
  >,
  passes: readonly Pick<MissionPolicyEntry, 'risk_id'>[],
  where: Where,
): PreviewNotice[] {
  // A connection default labels every resource found later (ADR
  // connection-default-environment-label): nothing to wait for.
  if (connection.derives_env || connection.default_env !== null) return [];
  const envScoped = connection.risks.filter((r) => r.env !== null);
  if (envScoped.length === 0) return [];
  const scopedIds = new Set(envScoped.map((r) => r.risk_id));
  const accepted = passes.map((p) => p.risk_id).filter((id) => scopedIds.has(id));
  return [
    {
      code: 'later-resources-need-env-label',
      message: `"${connection.display_name}" is given whole, resources found later included. The environment of a ${connection.provider_label} risk was checked against the resources known now: a resource found later reaches the risks that depend on the environment${
        accepted.length > 0 ? ` (${list(accepted)})` : ''
      } only once it carries its environment label on the connection's page (or the connection has a default environment); until then such a call is refused (risk-not-accepted).`,
      resource_refs: [],
      risk_ids: accepted,
      ...where,
    },
  ];
}

/**
 * Lines of a policy checked exactly as issuance checks the explicit lines of a draft
 * on one connection (`classifyLines`, then `issuesOf`): known to the catalog, inside
 * the creator's authority now, resolvable on the selected resources, with a budget
 * that `budgetProblem` accepts. A change of a mission's limits after issuance
 * (`MissionService.setLimits`) is judged by this and nothing else, so that whatever
 * caps a creation caps the change. Each line names its quota, rate and gate: no
 * preset fills anything in.
 */
export function checkPolicyLines(
  connection: IssuanceConnection,
  selected: readonly IssuanceResource[],
  lines: readonly MissionPolicyEntry[],
  index = 0,
): { readonly passes: readonly MissionPolicyEntry[]; readonly issues: readonly PreviewIssue[] } {
  const where: Where = { connection_index: index, connection_id: connection.id };
  const buckets = classifyLines(lines, {
    connection,
    selected,
    presetOnly: false,
    preset: { defaults: new Map(), unresolved: [] },
  });
  return { passes: buckets.passes, issues: issuesOf(buckets, connection, where) };
}

/**
 * What the built-in preset `everything-i-hold` wrote out on this connection,
 * said before anything is issued: how many lines, the most severe, the critical
 * ones that run freely, and the fallback by id (ADR
 * preset-everything-i-hold-expands-explicitly). `risk_ids`: the critical ids
 * running freely, then the fallback. The lines themselves are `passes`.
 */
export function everythingNotice(
  connection: Pick<IssuanceConnection, 'risks' | 'display_name' | 'provider_label'>,
  passes: readonly Pick<MissionPolicyEntry, 'risk_id' | 'gate'>[],
  where: Where,
): PreviewNotice {
  const digest = expansionDigest(passes, connection.risks);
  const name = connection.display_name;
  const severe = digest.most_severe
    ? ` Most severe: ${digest.most_severe.risk_id} (${digest.most_severe.level}).`
    : '';
  const critical =
    digest.critical_auto.length > 0
      ? ` Critical by the catalog's severity, gate auto (no approval asked): ${list(
          digest.critical_auto.map((r) => r.risk_id),
        )}.`
      : ' No critical risk among them.';
  const fallback =
    digest.fallback.length > 0
      ? ` Includes the fallback ${list(
          digest.fallback.map((r) => r.risk_id),
        )}: writes no other entry of the ${connection.provider_label} catalog names, which nobody reviewed.`
      : '';
  return {
    code: 'everything-i-hold-expanded',
    message: `Preset "${EVERYTHING_I_HOLD}" on "${name}" is written out as ${digest.count} explicit ${
      digest.count === 1 ? 'risk' : 'risks'
    } (listed in passes): every non-deprecated risk your authority covers that the selected resources can reach, each at the catalog's rate ceiling where one exists, gate auto.${severe}${critical}${fallback} The mission stores this list, not the preset; adjust it like any policy.`,
    resource_refs: [],
    risk_ids: [
      ...digest.critical_auto.map((r) => r.risk_id),
      ...digest.fallback.map((r) => r.risk_id),
    ],
    ...where,
  };
}

/** One connection of a draft against the creator's authority on it. */
export function previewConnection(
  connection: IssuanceConnection,
  draft: DraftConnection,
  index = 0,
): ConnectionOutcome {
  const where: Where = { connection_index: index, connection_id: connection.id };
  const resources = resolveResources(connection, draft, index);
  const reachesLater = draft.resources?.scope === 'connection';
  const preset = resolvePreset(connection, draft, resources.selected, where);

  // A draft with explicit lines accepts exactly those; a draft with only a
  // preset accepts the preset, bounded by what the creator holds and by what
  // the selected resources can resolve.
  const explicit = draft.policy ?? [];
  const presetOnly = explicit.length === 0 && preset.preset !== undefined;
  const lines: readonly DraftPolicyEntry[] = presetOnly ? preset.lines : explicit;
  const buckets = classifyLines(lines, {
    connection,
    selected: resources.selected,
    presetOnly,
    preset,
  });

  const issues = [...resources.issues, ...preset.issues, ...issuesOf(buckets, connection, where)];
  if (lines.length === 0 || (presetOnly && buckets.passes.length === 0)) {
    issues.push({
      code: 'no-accepted-risk',
      message: `Connection "${connection.display_name}" accepts no risk: pick a preset or accept at least one risk, or leave the connection out.`,
      ...where,
    });
  }

  return {
    preview: {
      connection_id: connection.id,
      provider: connection.provider,
      display_name: connection.display_name,
      resources: resources.selected,
      reaches_later: reachesLater,
      resources_total: resourcesTotal(connection, resources.selected),
      preset: preset.preset ? { id: preset.preset.id, label: preset.preset.label } : null,
      passes: buckets.passes,
      exceeds: buckets.exceeds,
      unknown: buckets.unknown,
      unresolvable: buckets.unresolvable,
      missing_budget: buckets.missingBudget,
      skipped_from_preset: buckets.skipped,
    },
    issues,
    notices: [
      ...(preset.preset?.id === EVERYTHING_I_HOLD
        ? [everythingNotice(connection, buckets.passes, where)]
        : []),
      ...envNotices(connection, resources.selected, buckets.passes, where),
      ...(reachesLater ? laterResourcesNotice(connection, buckets.passes, where) : []),
    ],
  };
}

/** The connection a draft line names, by id or by provider. */
function findConnection(
  context: PreviewContext,
  draft: DraftConnection,
  index: number,
): { connection: IssuanceConnection } | { issue: PreviewIssue } {
  if (draft.connection_id) {
    const found = context.connections.find((c) => c.id === draft.connection_id);
    if (found) return { connection: found };
    // One answer for "does not exist" and "not yours": no probing of other people's connections.
    return {
      issue: {
        code: 'connection-unknown',
        message: `Connection ${draft.connection_id} does not exist or you hold no authority on it.`,
        connection_index: index,
        connection_id: draft.connection_id,
      },
    };
  }
  if (draft.provider) {
    const candidates = context.connections.filter(
      (c) => c.provider === draft.provider && c.status === 'active',
    );
    const [only] = candidates;
    if (candidates.length === 1 && only) return { connection: only };
    return {
      issue:
        candidates.length === 0
          ? {
              code: 'connection-unknown',
              message: `You hold no active ${draft.provider} connection.`,
              connection_index: index,
            }
          : {
              code: 'connection-ambiguous',
              message: `You hold ${candidates.length} ${draft.provider} connections; name one by connection_id (${list(candidates.map((c) => c.id))}).`,
              connection_index: index,
            },
    };
  }
  return {
    issue: {
      code: 'connection-unknown',
      message: 'A connection is named by connection_id or by provider.',
      connection_index: index,
    },
  };
}

function periodIssue(period: DraftPeriod): PreviewIssue | null {
  if (period.kind === 'one-off') return null;
  const length = period.length_seconds;
  if (!Number.isInteger(length) || length < MIN_PERIOD_SECONDS || length > MAX_PERIOD_SECONDS) {
    return {
      code: 'invalid-period',
      message: `A recurring period lasts between ${MIN_PERIOD_SECONDS} seconds and ${MAX_PERIOD_SECONDS / 86_400} days.`,
    };
  }
  return null;
}

function expiryIssue(expiresAt: string | null, now: Date): PreviewIssue | null {
  if (expiresAt === null) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) {
    return { code: 'invalid-expiry', message: 'The expiry is not a valid date.' };
  }
  if (at <= now.getTime()) {
    return { code: 'invalid-expiry', message: 'The expiry is in the past.' };
  }
  return null;
}

/**
 * The whole draft. Never throws on a refusable draft: every reason is an
 * issue, so the creator (or the agent) fixes everything in one pass.
 */
export function previewDraft(context: PreviewContext, draft: MissionDraft): MissionPreview {
  const issues: PreviewIssue[] = [];
  const name = draft.name.trim();
  if (name.length === 0) {
    issues.push({ code: 'name-missing', message: 'Give the mission a name.' });
  } else if (name.length > MISSION_NAME_MAX_LENGTH) {
    issues.push({
      code: 'name-missing',
      message: `The name is longer than ${MISSION_NAME_MAX_LENGTH} characters.`,
    });
  }
  if (draft.connections.length === 0) {
    issues.push({ code: 'no-connection', message: 'A mission carries at least one connection.' });
  }

  const notices: PreviewNotice[] = [];
  const previews: ConnectionPreview[] = [];
  const used: IssuanceConnection[] = [];
  const seenConnections = new Set<string>();
  const seenProviders = new Map<string, string>();

  draft.connections.forEach((draftConnection, index) => {
    const found = findConnection(context, draftConnection, index);
    if ('issue' in found) {
      issues.push(found.issue);
      return;
    }
    const { connection } = found;
    const where = { connection_index: index, connection_id: connection.id };
    if (seenConnections.has(connection.id)) {
      issues.push({
        code: 'duplicate-connection',
        message: `Connection "${connection.display_name}" is listed twice.`,
        ...where,
      });
      return;
    }
    seenConnections.add(connection.id);
    const sameProvider = seenProviders.get(connection.provider);
    if (sameProvider !== undefined) {
      // The policy is keyed by RiskId, whose first segment is the provider: two
      // connections of one provider would share one partition and one budget.
      issues.push({
        code: 'duplicate-provider',
        message: `A mission carries one connection per provider, and "${sameProvider}" and "${connection.display_name}" are both ${connection.provider_label} connections. The risks and the budget of a mission are counted per provider, so a call could not say which of the two it means. Keep one of them in this mission and issue a second mission for the other.`,
        ...where,
      });
      return;
    }
    seenProviders.set(connection.provider, connection.display_name);
    if (connection.status !== 'active') {
      issues.push({
        code: 'connection-unavailable',
        message: `Connection "${connection.display_name}" is ${connection.status}; reconnect it before issuing a mission on it.`,
        ...where,
      });
    }
    const outcome = previewConnection(connection, draftConnection, index);
    issues.push(...outcome.issues);
    notices.push(...outcome.notices);
    previews.push(outcome.preview);
    used.push(connection);
  });

  const period = periodIssue(draft.period);
  if (period) issues.push(period);
  const expiry = expiryIssue(draft.expires_at, context.now);
  if (expiry) issues.push(expiry);

  const resolved: ResolvedDraftConnection[] = previews.map((p) => ({
    connection_id: p.connection_id,
    resources: p.reaches_later
      ? { scope: 'connection' }
      : { scope: 'selected', resource_ids: p.resources.map((r) => r.id) },
    preset: p.preset?.id ?? null,
    policy: p.passes,
  }));

  return {
    ok: issues.length === 0,
    issues,
    notices,
    name,
    connections: previews,
    policy: previews.flatMap((p) => p.passes),
    period: draft.period,
    expires_at: draft.expires_at,
    summary: summarize({
      connections: used,
      previews,
      period: draft.period,
      expires_at: draft.expires_at,
    }),
    resolved,
  };
}

/** The uncovered list of a preview: every accepted id outside the authority (spec §3.1). */
export function uncoveredOf(preview: Pick<MissionPreview, 'connections'>): RiskId[] {
  return preview.connections.flatMap((c) => c.exceeds);
}
