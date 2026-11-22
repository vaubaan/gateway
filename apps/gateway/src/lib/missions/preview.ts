/**
 * The issuance decision, as a pure function: a draft, checked against the
 * accounts the creator holds authority on, yields a preview — what passes,
 * what exceeds the authority, what cannot resolve, and whether the draft can
 * be issued as written.
 *
 * `MissionService.preview()` and `issue()` call it with the context read from
 * the store; the creation form calls it with the context the page was
 * rendered with, for instant feedback. `issue()` always recomputes it
 * server-side: the browser's copy decides nothing.
 *
 * Spec §3.1 (monotonicity, enumeration, partition per account, resource
 * selection), §3.2 (mandatory budget, macro-actions and trust levels), §0 "Resource" (env-qualified
 * ids resolve against the selected resources). Browser-safe: no IO.
 */
import {
  budgetIssues,
  exceedsRateCeiling,
  ROW_WORDS,
  type BudgetField,
} from '@vaubaan/policy-engine';
import type { Gate, MissionPolicyEntry, RateLimit, RiskId } from '@vaubaan/shared';
import { GATES } from '@vaubaan/shared/domain';

// The file, not the barrel: `catalog-authority.ts` is pure and browser-safe, the barrel is not.
import { uncoveredRisks } from '../authority/catalog-authority';
import { isResolvable } from './catalog-view';
import { EVERYTHING_I_HOLD, everythingIHold, expansionDigest } from './everything-i-hold';
import {
  knownTrustLevels,
  prefillOfTrustLevels,
  unknownMacroActions,
  type MacroActionTrustLevels,
} from './macro-actions';
import type {
  CatalogRisk,
  AccountPreview,
  DraftAccount,
  DraftPeriod,
  DraftPolicyEntry,
  DraftResourceSet,
  DraftResources,
  IssuanceAccount,
  IssuanceResource,
  LeftOutEntry,
  MissionDraft,
  MissionPreview,
  PreviewIssue,
  PreviewNotice,
  ResolvedDraftAccount,
  ResourceSetPreview,
  UnresolvableEntry,
} from './model';
import { draftSetsOf } from './model';
import { summarize } from './summary';

export const MISSION_NAME_MAX_LENGTH = 120;
/** Shortest recurring period: one minute. */
export const MIN_PERIOD_SECONDS = 60;
export const MAX_PERIOD_SECONDS = 366 * 24 * 3600;

export interface PreviewContext {
  /** Accounts the creator holds a non-empty authority on. */
  readonly accounts: readonly IssuanceAccount[];
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
 * applies to a macro-action's base budget. Issuance adds the catalog's rate ceiling.
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

/**
 * What a draft line leaves out, filled in: the prefill's line for that id,
 * else the risk's macro-action at its trust level.
 */
type LineDefaults = Omit<MissionPolicyEntry, 'risk_id'> | null;

/** The explicit entry a draft line resolves to, or `null` when its budget is missing. */
function resolveEntry(line: DraftPolicyEntry, defaults: LineDefaults): MissionPolicyEntry | null {
  const quota = line.quota ?? defaults?.quota;
  const rateLimit = line.rate_limit ?? defaults?.rate_limit;
  if (quota === undefined || rateLimit === undefined) return null;
  return {
    risk_id: line.risk_id,
    quota,
    rate_limit: { max: rateLimit.max, window_seconds: rateLimit.window_seconds },
    gate: line.gate ?? defaults?.gate ?? 'auto',
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
export function defaultResources(account: Pick<IssuanceAccount, 'resources'>): IssuanceResource[] {
  return account.resources.filter((r) => !r.hidden && !r.stale && !r.self);
}

/**
 * The resources "all" enters into a mission: `defaultResources`, less the unlabelled
 * ones where the service needs a label (`needsEnvLabel`). What a form preselects.
 */
export function enterableResources(
  account: Pick<IssuanceAccount, 'resources' | 'risks' | 'derives_env'>,
): IssuanceResource[] {
  const labelled = needsEnvLabel(account);
  return defaultResources(account).filter((r) => !labelled || r.env !== null);
}

/** The "M" of "N of M resources": the default set plus hidden resources picked on purpose. */
function resourcesTotal(
  account: Pick<IssuanceAccount, 'resources'>,
  selected: readonly IssuanceResource[],
): number {
  return defaultResources(account).length + selected.filter((r) => r.hidden).length;
}

/**
 * The resources one set asks for. A set taking "the rest" (`all`, `account`) gets
 * every resource of `defaultResources` no other set of the account selects
 * (`elsewhere`); with one set, nothing is elsewhere.
 */
function resolveResources(
  account: IssuanceAccount,
  wanted: DraftResources,
  where: Where,
  elsewhere: ReadonlySet<string> = new Set(),
  future = false,
): ResourceResolution {
  if (wanted.scope === 'all' || wanted.scope === 'account') {
    return {
      selected: defaultResources(account).filter((r) => !elsewhere.has(r.id)),
      issues: [],
    };
  }

  const byId = new Map(account.resources.map((r) => [r.id, r]));
  const byRef = new Map(account.resources.map((r) => [r.ref, r]));
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
      code: 'resource-not-in-account',
      message: `${foreign.length === 1 ? 'Resource' : 'Resources'} ${foreign.join(', ')} ${
        foreign.length === 1 ? 'does' : 'do'
      } not belong to account "${account.display_name}".`,
      resource_refs: foreign,
      ...where,
    });
  }
  const stale = [...selected.values()].filter((r) => r.stale);
  if (stale.length > 0) {
    issues.push({
      code: 'resource-stale',
      message: `No longer found on "${account.display_name}" at the service: ${stale
        .map((r) => r.ref)
        .join(', ')}. Refresh the account's resources or leave ${
        stale.length === 1 ? 'it' : 'them'
      } out.`,
      resource_refs: stale.map((r) => r.ref),
      ...where,
    });
    for (const r of stale) selected.delete(r.id);
  }
  // One of the instance's own resources (SEC 2026-10-15 H1): refused whoever
  // selects it, the creator's authority on the account notwithstanding.
  const self = [...selected.values()].filter((r) => r.self);
  if (self.length > 0) {
    issues.push({
      code: 'resource-self',
      message: `${self.map((r) => r.ref).join(', ')} on "${account.display_name}" ${
        self.length === 1 ? 'hosts' : 'host'
      } this instance: never reachable by a mission. Leave ${
        self.length === 1 ? 'it' : 'them'
      } out.`,
      resource_refs: self.map((r) => r.ref),
      ...where,
    });
    for (const r of self) selected.delete(r.id);
  }
  const nothing = foreign.length === 0 && stale.length === 0 && self.length === 0;
  // A set of future resources only may list none now.
  if (selected.size === 0 && nothing && !future) {
    issues.push({
      code: 'no-resource-selected',
      message: `Account "${account.display_name}" has no resource selected: the mission could touch nothing on it.`,
      ...where,
    });
  }
  // Keep the account's own order, so the persisted list is stable.
  return { selected: account.resources.filter((r) => selected.has(r.id)), issues };
}

interface AccountOutcome {
  readonly preview: AccountPreview;
  readonly issues: PreviewIssue[];
  /** Non-blocking: what the creator should know about a selection that passes. */
  readonly notices: PreviewNotice[];
}

/** Where an issue or a notice points: the draft line and the account it resolved to. */
interface Where {
  readonly account_index: number;
  readonly account_id: string;
  /** The resource set of the account, when the account has several. */
  readonly resource_set_index?: number;
}

function list(ids: readonly string[]): string {
  return ids.join(', ');
}

/**
 * What writes an account's policy when the draft gives no explicit lines:
 * `everything-i-hold`, or the trust levels of its macro-actions.
 */
interface Prefill {
  /** Set when the draft names `everything-i-hold`. */
  readonly everything: boolean;
  /** The lines it writes on this account, explicit ids only. */
  readonly lines: readonly MissionPolicyEntry[];
  /** What it left out, reported when it writes the policy. */
  readonly left_out: readonly LeftOutEntry[];
  /** The trust levels of the draft that name a macro-action here. */
  readonly trustLevels: MacroActionTrustLevels;
  readonly issues: PreviewIssue[];
}

/** The prefill a draft names on an account, against the selected resources. */
function resolvePrefill(
  account: IssuanceAccount,
  draft: DraftResourceSet,
  selected: readonly IssuanceResource[],
  where: Where,
): Prefill {
  const trustLevels = knownTrustLevels(account, draft.trust_levels);
  const issues: PreviewIssue[] = [];
  // The built-in `everything-i-hold` is computed here, against this selection (ADR
  // preset-everything-i-hold-expands-explicitly).
  if (draft.everything_i_hold === true) {
    const lines = everythingIHold(account, selected).entries;
    return { everything: true, lines, left_out: [], trustLevels, issues };
  }
  // Trust levels naming nothing here: dropped beside explicit lines (they then only
  // redraw the form), refused when they are what writes the policy.
  const unknown = unknownMacroActions(account, draft.trust_levels);
  if ((draft.policy ?? []).length === 0 && unknown.length > 0) {
    issues.push({
      code: 'unknown-macro-action',
      message: `Not ${unknown.length === 1 ? 'a macro-action' : 'macro-actions'} of ${account.service_label}: ${list(unknown)} (known: ${list(
        account.macro_actions.map((action) => action.id),
      )}).`,
      ...where,
    });
  }
  const written = prefillOfTrustLevels(account, trustLevels, selected);
  const lines = written.lines.map(({ risk_id, quota, rate_limit, gate }): MissionPolicyEntry => ({
    risk_id,
    quota,
    rate_limit,
    gate,
  }));
  return { everything: false, lines, left_out: written.left_out, trustLevels, issues };
}

/** Where each line of an account's policy ends up. */
interface LineBuckets {
  /** Accepted, inside the authority, resolvable, with a valid resolved budget. */
  readonly passes: MissionPolicyEntry[];
  readonly exceeds: RiskId[];
  readonly unknown: RiskId[];
  readonly unresolvable: UnresolvableEntry[];
  readonly missingBudget: RiskId[];
  readonly duplicates: RiskId[];
  /** What the prefill left out when it writes the policy. */
  readonly leftOut: LeftOutEntry[];
  readonly invalid: { risk_id: RiskId; problem: string }[];
}

interface ClassifyInput {
  readonly account: IssuanceAccount;
  readonly selected: readonly IssuanceResource[];
  /** The prefill writes the policy: what the creator does not hold or cannot resolve is left out. */
  readonly prefillOnly: boolean;
  /** The budget and gate a line that gives none takes. */
  readonly defaultsOf: (risk: CatalogRisk) => LineDefaults;
}

/**
 * Sorts each line into exactly one bucket, first reason wins: duplicate,
 * unknown to the catalog, outside the authority, unresolvable environment,
 * no budget, invalid budget — otherwise it passes.
 */
function classifyLines(lines: readonly DraftPolicyEntry[], input: ClassifyInput): LineBuckets {
  const { account, selected, prefillOnly, defaultsOf } = input;
  const catalog = new Map(account.risks.map((r) => [r.risk_id, r]));
  // Monotonicity (spec §3.1): the lines the creator's authority does not cover.
  const outside = new Set(
    uncoveredRisks(
      { riskIds: account.authority },
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
    leftOut: [],
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
      if (prefillOnly) {
        buckets.leftOut.push({ risk_id: line.risk_id, reason: 'outside-authority', env: risk.env });
      } else buckets.exceeds.push(line.risk_id);
      continue;
    }
    if (!isResolvable(risk, account, selected)) {
      if (prefillOnly) {
        buckets.leftOut.push({ risk_id: line.risk_id, reason: 'unresolvable-env', env: risk.env });
      } else buckets.unresolvable.push({ risk_id: line.risk_id, env: risk.env ?? '' });
      continue;
    }
    const entry = resolveEntry(line, defaultsOf(risk));
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
  account: Pick<IssuanceAccount, 'display_name' | 'service_label'>,
  where: Where,
): PreviewIssue[] {
  const { unknown, duplicates, exceeds, unresolvable, missingBudget, invalid } = buckets;
  const name = account.display_name;
  const issues: PreviewIssue[] = [];
  if (unknown.length > 0) {
    issues.push({
      code: 'unknown-risk',
      message: `Not ${unknown.length === 1 ? 'a risk' : 'risks'} of the ${account.service_label} catalog: ${list(unknown)}. A mission policy is an explicit enumeration of catalog ids.`,
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
  account: Pick<IssuanceAccount, 'risks' | 'derives_env' | 'display_name' | 'service_label'>,
  selected: readonly (Pick<IssuanceResource, 'ref' | 'env'> &
    Partial<Pick<IssuanceResource, 'display_name'>>)[],
  passes: readonly Pick<MissionPolicyEntry, 'risk_id'>[],
  where: Where,
): PreviewNotice[] {
  if (account.derives_env) return [];
  const envScoped = account.risks.filter((r) => r.env !== null);
  if (envScoped.length === 0) return [];
  const envs = [...new Set(envScoped.flatMap((r) => (r.env === null ? [] : [r.env])))];
  const scopedIds = new Set(envScoped.map((r) => r.risk_id));
  const accepted = passes.map((p) => p.risk_id).filter((id) => scopedIds.has(id));
  const name = account.display_name;
  const consequence = `${account.service_label} risks that depend on the environment can never be touched there: a call that touches one is refused (risk-not-accepted), whatever the mission accepts${
    accepted.length > 0 ? ` — including ${list(accepted)}` : ''
  }.`;
  const remedy = `Label the resource on the account's page (${list(envs)}) or leave it out.`;
  const unlabelledRemedy = `Label the resource on the account's page (${list(envs)}), give the account a default environment for its unlabelled resources, or leave it out.`;

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
      message: `${list(foreign.map((r) => `${called(r)} (labelled "${r.env}")`))} on "${name}": no ${account.service_label} risk is acceptable in that environment. ${consequence} ${remedy}`,
      resource_refs: foreign.map((r) => r.ref),
      risk_ids: accepted,
      ...where,
    });
  }
  return notices;
}

/**
 * Lines of a policy checked exactly as issuance checks the explicit lines of a draft
 * on one account (`classifyLines`, then `issuesOf`): known to the catalog, inside
 * the creator's authority now, resolvable on the selected resources, with a budget
 * that `budgetProblem` accepts. A change of a mission's limits after issuance
 * (`MissionService.setLimits`) is judged by this and nothing else, so that whatever
 * caps a creation caps the change. Each line names its quota, rate and gate: no
 * macro-action fills anything in.
 */
export function checkPolicyLines(
  account: IssuanceAccount,
  selected: readonly IssuanceResource[],
  lines: readonly MissionPolicyEntry[],
  index = 0,
): { readonly passes: readonly MissionPolicyEntry[]; readonly issues: readonly PreviewIssue[] } {
  const where: Where = { account_index: index, account_id: account.id };
  const buckets = classifyLines(lines, {
    account,
    selected,
    prefillOnly: false,
    defaultsOf: () => null,
  });
  return { passes: buckets.passes, issues: issuesOf(buckets, account, where) };
}

/**
 * What the built-in `everything-i-hold` wrote out on this account,
 * said before anything is issued: how many lines, the hardest to repair, those
 * that cannot be repaired and run freely, and the fallback by id (ADR
 * preset-everything-i-hold-expands-explicitly). `risk_ids`: the row-4 ids
 * running freely, then the fallback. The lines themselves are `passes`.
 */
export function everythingNotice(
  account: Pick<IssuanceAccount, 'risks' | 'display_name' | 'service_label'>,
  passes: readonly Pick<MissionPolicyEntry, 'risk_id' | 'gate'>[],
  where: Where,
): PreviewNotice {
  const digest = expansionDigest(passes, account.risks);
  const name = account.display_name;
  const severe = digest.hardest
    ? ` The hardest to repair: ${digest.hardest.risk_id} (${ROW_WORDS[digest.hardest.row]}).`
    : '';
  const critical =
    digest.irreparable_auto.length > 0
      ? ` ${ROW_WORDS[4]}, gate auto (no approval asked): ${list(
          digest.irreparable_auto.map((r) => r.risk_id),
        )}.`
      : ` None of them is in the row "${ROW_WORDS[4]}".`;
  const fallback =
    digest.fallback.length > 0
      ? ` Includes the fallback ${list(
          digest.fallback.map((r) => r.risk_id),
        )}: writes no other entry of the ${account.service_label} catalog names, which nobody reviewed.`
      : '';
  return {
    code: 'everything-i-hold-expanded',
    message: `"${EVERYTHING_I_HOLD}" on "${name}" is written out as ${digest.count} explicit ${
      digest.count === 1 ? 'risk' : 'risks'
    } (listed in passes): every non-deprecated risk your authority covers that the selected resources can reach, each at the catalog's rate ceiling where one exists, gate auto.${severe}${critical}${fallback} The mission stores this list, not "${EVERYTHING_I_HOLD}"; adjust it like any policy.`,
    resource_refs: [],
    risk_ids: [
      ...digest.irreparable_auto.map((r) => r.risk_id),
      ...digest.fallback.map((r) => r.risk_id),
    ],
    ...where,
  };
}

/** What one set of an account yields, with the issues and notices about it. */
interface SetOutcome {
  readonly preview: ResourceSetPreview;
  readonly resourcesTotal: number;
  readonly issues: PreviewIssue[];
  readonly notices: PreviewNotice[];
}

/**
 * One set of an account after normalization: its draft as `resource_sets` gives it —
 * an explicit selection, `future`, the policy lines that apply in its environment, and
 * `env` when it lists no resource — and the resources that selection resolved to.
 * Previewing the normalized draft again yields the same sets (`normalizeDraft`).
 */
interface NormalSet {
  readonly draft: DraftResourceSet;
  readonly resources: ResourceResolution;
  /** One of several sets a legacy selection was split into (`splitByEnvironment`). */
  readonly split?: true;
}

/** One set of a draft account, on the resources it was given. */
function previewSet(
  account: IssuanceAccount,
  set: NormalSet,
  index: number,
  where: Where,
): SetOutcome {
  const { draft, resources } = set;
  // Several sets: each sentence names its set beside the account ("acme — resource set 2").
  const named =
    where.resource_set_index === undefined
      ? account
      : { ...account, display_name: `${account.display_name} — resource set ${index + 1}` };
  const prefill = resolvePrefill(named, draft, resources.selected, where);

  // A draft with explicit lines accepts exactly those; a draft without writes
  // its policy from `everything-i-hold` or its trust levels, bounded by what the
  // creator holds and by what the selected resources can resolve.
  const explicit = draft.policy ?? [];
  const prefillOnly = explicit.length === 0 && (prefill.everything || prefill.lines.length > 0);
  const lines: readonly DraftPolicyEntry[] = prefillOnly ? prefill.lines : explicit;
  // Beside explicit lines, only `everything-i-hold` fills a budget a line omits;
  // trust levels then only redraw the form, and a line without a budget is missing one.
  const fills = new Map(
    (prefillOnly || prefill.everything ? prefill.lines : []).map((line) => [line.risk_id, line]),
  );
  const buckets = classifyLines(lines, {
    account,
    selected: resources.selected,
    prefillOnly,
    defaultsOf: (risk) => fills.get(risk.risk_id) ?? null,
  });

  const env = envOfSet(account, set, named, where);
  const issues = [
    ...resources.issues,
    ...env.issues,
    ...prefill.issues,
    ...issuesOf(buckets, named, where),
  ];
  if (lines.length === 0 || (prefillOnly && buckets.passes.length === 0)) {
    issues.push({
      code: 'no-accepted-risk',
      message: `Account "${named.display_name}" accepts no risk: tick a macro-action or accept at least one risk, or leave the account out.`,
      ...where,
    });
  }

  return {
    preview: {
      index,
      id: draft.id ?? null,
      resources: resources.selected,
      future: draft.future === true,
      env: env.env,
      everything_i_hold: prefill.everything,
      passes: buckets.passes,
      exceeds: buckets.exceeds,
      unknown: buckets.unknown,
      unresolvable: buckets.unresolvable,
      missing_budget: buckets.missingBudget,
      left_out: prefillOnly ? [...prefill.left_out, ...buckets.leftOut] : [],
      trust_levels: prefill.trustLevels,
    },
    resourcesTotal: resourcesTotal(account, resources.selected),
    issues,
    notices: [
      ...(prefill.everything ? [everythingNotice(named, buckets.passes, where)] : []),
      ...envNotices(named, resources.selected, buckets.passes, where),
    ],
  };
}

/**
 * True when a resource of this account must carry an environment label to enter a
 * set: its catalog has env-qualified risks and the plugin does not read the environment
 * from the call itself (ADR resource-set-is-one-environment-with-optional-future-resources).
 */
export function needsEnvLabel(account: Pick<IssuanceAccount, 'risks' | 'derives_env'>): boolean {
  return !account.derives_env && account.risks.some((r) => r.env !== null);
}

/**
 * The environment of one set — the label every resource carries, else the one the
 * draft gave, else the one it takes when empty — and why it cannot be stored: resources
 * of several environments (`resource-set-mixed-env`), or no label where the service
 * needs one (`resource-unlabelled`).
 */
function envOfSet(
  account: IssuanceAccount,
  set: NormalSet,
  named: Pick<IssuanceAccount, 'display_name'>,
  where: Where,
): { readonly env: string | null; readonly issues: PreviewIssue[] } {
  const envs = new Set(set.resources.selected.map((r) => r.env));
  if (set.draft.env !== undefined) envs.add(set.draft.env);
  const issues: PreviewIssue[] = [];
  if (envs.size > 1) {
    const labels = [...envs].map((e) => (e === null ? 'no label' : `"${e}"`));
    issues.push({
      code: 'resource-set-mixed-env',
      message: `"${named.display_name}" mixes environments (${list(labels)}): a resource set holds the resources of one environment. Split it into one set per environment.`,
      resource_refs: set.resources.selected.map((r) => r.ref),
      ...where,
    });
  }
  const [first = null] = envs;
  const env = envs.size > 1 ? null : first;
  const unlabelled = set.resources.selected.filter((r) => r.env === null);
  const futureOnly = set.draft.future === true && set.resources.selected.length === 0;
  if (
    needsEnvLabel(account) &&
    envs.size <= 1 &&
    env === null &&
    (unlabelled.length > 0 || futureOnly)
  ) {
    issues.push({
      code: 'resource-unlabelled',
      message:
        unlabelled.length > 0
          ? `No environment label on ${list(unlabelled.map((r) => r.display_name || r.ref))} ("${named.display_name}"): ${account.service_label} has permissions that depend on the environment, so a resource enters a mission only once labelled. Label it on the account's page, give the account a default environment, or leave it out.`
          : `"${named.display_name}" takes future resources without an environment: ${account.service_label} has permissions that depend on the environment. Name the environment of the set.`,
      resource_refs: unlabelled.map((r) => r.ref),
      ...where,
    });
  }
  return { env, issues };
}

/** The environment a risk id is qualified with (`supabase[prod].row-write` → `prod`), or `null`. */
function qualifiedEnvOf(riskId: RiskId): string | null {
  return /^[^.[]+\[([^\]]+)\]\./.exec(riskId)?.[1] ?? null;
}

/**
 * The lines of `policy` that apply in `env`: every unqualified line, and the lines
 * qualified with `env`. A line qualified with an environment no set of the split holds
 * stays in the first set, where it is reported `unresolvable-env`.
 */
function linesForEnv(
  policy: readonly DraftPolicyEntry[] | undefined,
  env: string | null,
  envs: readonly (string | null)[],
  first: boolean,
): readonly DraftPolicyEntry[] | undefined {
  if (policy === undefined) return undefined;
  return policy.filter((line) => {
    const qualified = qualifiedEnvOf(line.risk_id);
    if (qualified === null || qualified === env) return true;
    return first && !envs.includes(qualified);
  });
}

/** The resources grouped by environment, in the account's own order. */
function byEnvironment(
  resources: readonly IssuanceResource[],
): Map<string | null, IssuanceResource[]> {
  const groups = new Map<string | null, IssuanceResource[]>();
  for (const r of resources) groups.set(r.env, [...(groups.get(r.env) ?? []), r]);
  return groups;
}

/** True when a set takes "the rest" of the account: every resource no other set selects. */
function takesTheRest(set: DraftResourceSet): boolean {
  const scope = set.resources?.scope ?? 'all';
  return scope === 'all' || scope === 'account';
}

/**
 * One draft set split into one set per environment of its resources, each with the
 * policy lines that apply in its environment, as an explicit selection; the first keeps
 * the draft's `id` and what the selection named that resolved to nothing (reported
 * again when the normalized draft is previewed). `env` is written only on a set that
 * lists no resource.
 */
function splitByEnvironment(
  set: DraftResourceSet,
  resolution: ResourceResolution,
  future: boolean,
  emptyEnv: string | null,
): NormalSet[] {
  const { id, policy, resources: wanted, env: _env, future: _future, ...rest } = set;
  const resolvedIds = new Set(resolution.selected.map((r) => r.id));
  const resolvedRefs = new Set(resolution.selected.map((r) => r.ref));
  const leftoverIds =
    wanted?.scope === 'selected'
      ? (wanted.resource_ids ?? []).filter((r) => !resolvedIds.has(r))
      : [];
  const leftoverRefs =
    wanted?.scope === 'selected'
      ? (wanted.resource_refs ?? []).filter((r) => !resolvedRefs.has(r))
      : [];
  const groups = byEnvironment(resolution.selected);
  const envs: (string | null)[] = groups.size === 0 ? [emptyEnv] : [...groups.keys()];
  return envs.map((env, i): NormalSet => {
    const members = groups.get(env) ?? [];
    const lines = envs.length > 1 ? linesForEnv(policy, env, envs, i === 0) : policy;
    const ids = members.map((r) => r.id);
    return {
      draft: {
        ...(i === 0 && id !== undefined ? { id } : {}),
        resources: {
          scope: 'selected',
          resource_ids: i === 0 ? [...ids, ...leftoverIds] : ids,
          ...(i === 0 && leftoverRefs.length > 0 ? { resource_refs: leftoverRefs } : {}),
        },
        future,
        ...(members.length === 0 ? { env } : {}),
        ...rest,
        ...(lines !== undefined ? { policy: lines } : {}),
      },
      resources: { selected: members, issues: i === 0 ? resolution.issues : [] },
      ...(envs.length > 1 ? { split: true as const } : {}),
    };
  });
}

/**
 * The sets of an account as they would be stored (risk model §4.7; ADR
 * resource-set-is-one-environment-with-optional-future-resources): the explicit
 * selections first, each resource in one set only; then the one set that takes the
 * rest (`all`, `account`), if any. A legacy selection — the flat shape, `all`,
 * `account` — is split by environment (a resource without a label left out of the
 * rest where the service needs one); a set given in `resource_sets` with `selected` is
 * kept whole, and refused if it mixes environments.
 */
function normalizeSets(
  account: IssuanceAccount,
  draft: DraftAccount,
  where: Where,
): {
  readonly sets: NormalSet[];
  readonly issues: PreviewIssue[];
  readonly notices: PreviewNotice[];
} {
  const sets = draftSetsOf(draft);
  const flat = draft.resource_sets === undefined;
  const several = sets.length > 1;
  const whereOf = (index: number): Where =>
    several ? { ...where, resource_set_index: index } : where;
  const explicit = sets.map((set, index) =>
    takesTheRest(set)
      ? null
      : resolveResources(
          account,
          set.resources ?? { scope: 'all' },
          whereOf(index),
          new Set(),
          set.future === true,
        ),
  );
  const issues: PreviewIssue[] = [];
  const notices: PreviewNotice[] = [];
  const owner = new Map<string, number>();
  const twice = new Set<string>();
  explicit.forEach((resolution, index) => {
    for (const r of resolution?.selected ?? []) {
      if (owner.has(r.id) && owner.get(r.id) !== index) twice.add(r.ref);
      else owner.set(r.id, index);
    }
  });
  if (twice.size > 0) {
    issues.push({
      code: 'resource-sets-overlap',
      message: `On "${account.display_name}", ${[...twice].join(', ')} ${
        twice.size === 1 ? 'is' : 'are'
      } in two resource sets: a resource belongs to one set only.`,
      resource_refs: [...twice],
      ...where,
    });
  }
  const rest = sets.filter(takesTheRest);
  if (rest.length > 1) {
    issues.push({
      code: 'resource-sets-overlap',
      message: `On "${account.display_name}", ${rest.length} resource sets take every resource no other set selects ("All resources" or "The whole account"): only one set may.`,
      ...where,
    });
  }
  const elsewhere = new Set(owner.keys());
  const normal = sets.flatMap((set, index): NormalSet[] => {
    const given = explicit[index];
    if (given) {
      // A set of `resource_sets` is kept whole: mixing environments is its issue.
      if (!flat) return [{ draft: set, resources: given }];
      return byEnvironment(given.selected).size > 1
        ? splitByEnvironment(set, given, set.future === true, set.env ?? null)
        : [{ draft: set, resources: given }];
    }
    const legacyFuture = set.resources?.scope === 'account';
    const future = set.future ?? legacyFuture;
    let resolution = resolveResources(
      account,
      set.resources ?? { scope: 'all' },
      whereOf(index),
      elsewhere,
    );
    if (needsEnvLabel(account)) {
      const unlabelled = resolution.selected.filter((r) => r.env === null);
      if (unlabelled.length > 0) {
        notices.push({
          code: 'unlabelled-resources-left-out',
          message: `Left out on "${account.display_name}", without an environment label: ${list(
            unlabelled.map((r) => r.display_name || r.ref),
          )}. ${account.service_label} has permissions that depend on the environment, so a resource enters a mission only once labelled.`,
          resource_refs: unlabelled.map((r) => r.ref),
          risk_ids: [],
          ...whereOf(index),
        });
        resolution = { ...resolution, selected: resolution.selected.filter((r) => r.env !== null) };
      }
    }
    // A set of future resources only takes the environment later resources inherit.
    const emptyEnv = set.env !== undefined ? set.env : future ? account.default_env : null;
    return splitByEnvironment(set, resolution, future, emptyEnv);
  });
  if (normal.length > sets.length) {
    notices.push({
      code: 'split-by-environment',
      message: `"${account.display_name}" is given as ${normal.length} resource sets, one per environment, each with the permissions that apply there: a resource set holds the resources of one environment.`,
      resource_refs: [],
      risk_ids: [],
      ...where,
    });
  }
  const futureEnvs = new Map<string | null, number>();
  for (const set of normal) {
    if (set.draft.future !== true) continue;
    const env = set.resources.selected[0]?.env ?? set.draft.env ?? null;
    futureEnvs.set(env, (futureEnvs.get(env) ?? 0) + 1);
  }
  for (const [env, count] of futureEnvs) {
    if (count < 2) continue;
    issues.push({
      code: 'resource-sets-overlap',
      message: `On "${account.display_name}", ${count} resource sets take the future resources of ${
        env === null ? 'no environment' : `"${env}"`
      }: only one set may, so a new resource knows where it goes.`,
      ...where,
    });
  }
  return { sets: normal, issues, notices };
}

/** Each set previewed at its place: "resource set N" only when there are several. */
function previewSets(account: IssuanceAccount, sets: readonly NormalSet[], where: Where) {
  const several = sets.length > 1;
  return sets.map((set, index) =>
    previewSet(account, set, index, several ? { ...where, resource_set_index: index } : where),
  );
}

/**
 * The normalized sets of an account and what each yields. A set a split made that
 * accepts nothing, and is refused for that alone (`no-accepted-risk`), is dropped while
 * another set of the split accepts something: the lines of a legacy draft apply to some
 * environments only (a macro-action of prod risks), and its other environments are left
 * out rather than refusing the draft. Any other issue keeps the set, so nothing is
 * narrowed silently.
 */
function settledSets(
  account: IssuanceAccount,
  draft: DraftAccount,
  where: Where,
): { readonly normalized: ReturnType<typeof normalizeSets>; readonly outcomes: SetOutcome[] } {
  const normalized = normalizeSets(account, draft, where);
  const outcomes = previewSets(account, normalized.sets, where);
  const idle = (o: SetOutcome): boolean =>
    o.preview.passes.length === 0 && o.issues.every((i) => i.code === 'no-accepted-risk');
  if (!outcomes.some((o) => !idle(o))) return { normalized, outcomes };
  const kept = normalized.sets.filter((set, i) => {
    const outcome = outcomes[i];
    return !(set.split === true && outcome !== undefined && idle(outcome));
  });
  if (kept.length === normalized.sets.length) return { normalized, outcomes };
  return {
    normalized: { ...normalized, sets: kept },
    outcomes: previewSets(account, kept, where),
  };
}

/** One account of a draft against the creator's authority on it. */
export function previewAccount(
  account: IssuanceAccount,
  draft: DraftAccount,
  index = 0,
): AccountOutcome {
  const where: Where = { account_index: index, account_id: account.id };
  const issues: PreviewIssue[] = [];
  const mixed =
    draft.resource_sets !== undefined &&
    (draft.resources !== undefined ||
      draft.future !== undefined ||
      draft.env !== undefined ||
      draft.policy !== undefined ||
      draft.trust_levels !== undefined ||
      draft.everything_i_hold !== undefined);
  if (mixed) {
    issues.push({
      code: 'resource-sets-mixed',
      message: `Account "${account.display_name}" gives resource_sets and, beside them, its own resources, policy, trust_levels or everything_i_hold: give each set its own, and nothing beside them.`,
      ...where,
    });
  }
  if (draftSetsOf(draft).length === 0) {
    issues.push({
      code: 'no-resource-selected',
      message: `Account "${account.display_name}" has no resource set: the mission could touch nothing on it.`,
      ...where,
    });
  }
  const { normalized, outcomes } = settledSets(account, draft, where);
  issues.push(...normalized.issues);
  const previews = outcomes.map((o) => o.preview);
  const resources = account.resources.filter((r) =>
    previews.some((set) => set.resources.some((own) => own.id === r.id)),
  );
  const [first] = previews;
  return {
    preview: {
      account_id: account.id,
      service: account.service,
      display_name: account.display_name,
      resources,
      future: previews.some((set) => set.future),
      resources_total: resourcesTotal(account, resources),
      everything_i_hold: previews.some((set) => set.everything_i_hold),
      passes: previews.flatMap((set) => set.passes),
      exceeds: [...new Set(previews.flatMap((set) => set.exceeds))],
      unknown: [...new Set(previews.flatMap((set) => set.unknown))],
      unresolvable: previews.flatMap((set) => set.unresolvable),
      missing_budget: [...new Set(previews.flatMap((set) => set.missing_budget))],
      left_out: previews.flatMap((set) => set.left_out),
      trust_levels: first?.trust_levels ?? {},
      resource_sets: previews,
    },
    issues: [...issues, ...outcomes.flatMap((o) => o.issues)],
    notices: [...normalized.notices, ...outcomes.flatMap((o) => o.notices)],
  };
}

/**
 * The draft with every account the context knows given as `resource_sets` of one
 * environment each — what `previewDraft` stores — and the notices the normalization
 * gave. An account that gives `resource_sets` beside its own fields is left as it is
 * (`resource-sets-mixed`). The edit's judgement reads the normalized draft, so that its
 * draft sets and the preview's sets are the same list.
 */
export function normalizeDraft(
  context: PreviewContext,
  draft: MissionDraft,
): { readonly draft: MissionDraft; readonly notices: readonly PreviewNotice[] } {
  const notices: PreviewNotice[] = [];
  const accounts = draft.accounts.map((line, index): DraftAccount => {
    const found = findAccount(context, line, index);
    if ('issue' in found) return line;
    const mixed =
      line.resource_sets !== undefined &&
      (line.resources !== undefined ||
        line.future !== undefined ||
        line.env !== undefined ||
        line.policy !== undefined ||
        line.trust_levels !== undefined ||
        line.everything_i_hold !== undefined);
    if (mixed) return line;
    const where: Where = { account_index: index, account_id: found.account.id };
    const { normalized } = settledSets(found.account, line, where);
    notices.push(...normalized.notices);
    return {
      account_id: found.account.id,
      resource_sets: normalized.sets.map((set) => set.draft),
    };
  });
  return { draft: { ...draft, accounts }, notices };
}

/** The account a draft line names, by id or by service. */
function findAccount(
  context: PreviewContext,
  draft: DraftAccount,
  index: number,
): { account: IssuanceAccount } | { issue: PreviewIssue } {
  if (draft.account_id) {
    const found = context.accounts.find((c) => c.id === draft.account_id);
    if (found) return { account: found };
    // One answer for "does not exist" and "not yours": no probing of other people's accounts.
    return {
      issue: {
        code: 'account-unknown',
        message: `Account ${draft.account_id} does not exist or you hold no authority on it.`,
        account_index: index,
        account_id: draft.account_id,
      },
    };
  }
  if (draft.service) {
    const candidates = context.accounts.filter(
      (c) => c.service === draft.service && c.status === 'active',
    );
    const [only] = candidates;
    if (candidates.length === 1 && only) return { account: only };
    return {
      issue:
        candidates.length === 0
          ? {
              code: 'account-unknown',
              message: `You hold no active ${draft.service} account.`,
              account_index: index,
            }
          : {
              code: 'account-ambiguous',
              message: `You hold ${candidates.length} ${draft.service} accounts; name one by account_id (${list(candidates.map((c) => c.id))}).`,
              account_index: index,
            },
    };
  }
  return {
    issue: {
      code: 'account-unknown',
      message: 'An account is named by account_id or by service.',
      account_index: index,
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
  if (draft.accounts.length === 0) {
    issues.push({ code: 'no-account', message: 'A mission carries at least one account.' });
  }

  const notices: PreviewNotice[] = [];
  const previews: AccountPreview[] = [];
  const used: IssuanceAccount[] = [];
  const seenAccounts = new Set<string>();

  draft.accounts.forEach((draftAccount, index) => {
    const found = findAccount(context, draftAccount, index);
    if ('issue' in found) {
      issues.push(found.issue);
      return;
    }
    const { account } = found;
    const where = { account_index: index, account_id: account.id };
    if (seenAccounts.has(account.id)) {
      issues.push({
        code: 'duplicate-account',
        message: `Account "${account.display_name}" is listed twice.`,
        ...where,
      });
      return;
    }
    seenAccounts.add(account.id);
    if (account.status !== 'active') {
      issues.push({
        code: 'account-unavailable',
        message: `Account "${account.display_name}" is ${account.status}; reconnect it before issuing a mission on it.`,
        ...where,
      });
    }
    const outcome = previewAccount(account, draftAccount, index);
    issues.push(...outcome.issues);
    notices.push(...outcome.notices);
    previews.push(outcome.preview);
    used.push(account);
  });

  const period = periodIssue(draft.period);
  if (period) issues.push(period);
  const expiry = expiryIssue(draft.expires_at, context.now);
  if (expiry) issues.push(expiry);

  const resolved: ResolvedDraftAccount[] = previews.map((p) => ({
    account_id: p.account_id,
    resource_sets: p.resource_sets.map((set) => ({
      ...(set.id !== null ? { id: set.id } : {}),
      resources: { scope: 'selected', resource_ids: set.resources.map((r) => r.id) },
      future: set.future,
      env: set.env,
      everything_i_hold: set.everything_i_hold,
      policy: set.passes,
      trust_levels: set.trust_levels,
    })),
  }));

  return {
    ok: issues.length === 0,
    issues,
    notices,
    name,
    accounts: previews,
    policy: previews.flatMap((p) => p.passes),
    period: draft.period,
    expires_at: draft.expires_at,
    summary: summarize({
      accounts: used,
      previews,
      period: draft.period,
      expires_at: draft.expires_at,
    }),
    resolved,
  };
}

/** The uncovered list of a preview: every accepted id outside the authority (spec §3.1). */
export function uncoveredOf(preview: Pick<MissionPreview, 'accounts'>): RiskId[] {
  return preview.accounts.flatMap((c) => c.exceeds);
}
