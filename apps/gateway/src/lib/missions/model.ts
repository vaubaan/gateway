/**
 * Vocabulary of mission issuance: the draft a creator (or, later, an agent on
 * the management door) submits, the issuance context it is checked against,
 * and the preview that says what passes.
 *
 * Wire shapes are snake_case like the shared domain (`MissionPolicyEntry`),
 * because the same draft and preview are exposed as-is on the management door
 * (spec §4.1 bis). Types and pure helpers only: this file is safe to import from a
 * client component.
 */
import type { ResourceNoun } from '@vaubaan/plugin-sdk';
import type { Reason, RiskKind, Row, TrustLevel } from '@vaubaan/policy-engine';
import type {
  Gate,
  MacroAction,
  MissionPolicyEntry,
  RateLimit,
  RiskId,
  RiskVector,
} from '@vaubaan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Draft
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One accepted risk of a draft. `quota`, `rate_limit` and `gate` may be
 * omitted when the account names `everything-i-hold`: they then come from
 * its line for that risk.
 * A risk whose budget resolves from neither is refused (spec §3.2: "the
 * gateway refuses to issue a mission whose accepted risk has no resolved
 * budget"). The gate alone has a default, `auto`.
 */
export interface DraftPolicyEntry {
  readonly risk_id: RiskId;
  readonly quota?: number;
  readonly rate_limit?: RateLimit;
  readonly gate?: Gate;
}

/**
 * The resources a mission may touch on one account (spec §3.1 "Resource
 * selection"; ADR resource-set-is-one-environment-with-optional-future-resources).
 * A set is always stored as an explicit list of one environment:
 *
 * - `selected` names resources by id (the interface) or by ref (an agent's
 *   proposal, which only knows refs) — the set's list;
 * - `all` (legacy) is every resource known now that the owner did not hide and
 *   discovery still returns, and that no other set selects;
 * - `account` (legacy) is `all` with `future` on.
 *
 * `all` and `account`, and a selection given without `resource_sets`, are split
 * by environment into one set per environment, each with the policy lines that
 * apply there (`previewDraft`); a resource without a label is left out of `all` and
 * `account` when the service's catalog has env-qualified risks.
 */
export type DraftResources =
  | { readonly scope: 'all' }
  | { readonly scope: 'account' }
  | {
      readonly scope: 'selected';
      readonly resource_ids?: readonly string[];
      readonly resource_refs?: readonly string[];
    };

/**
 * One account of a draft with its partition of the policy (spec §3.1 "A
 * multi-account mission composes its authority account by account").
 *
 * The account is named by id, or by `service` when the creator holds
 * exactly one usable account of that service (an agent's proposal).
 *
 * `trust levels` + no `policy`   → what the macro-actions write at their trust levels,
 *                           bounded by the authority and the selection.
 * `everything-i-hold`     → every risk held there that the selection reaches.
 * `policy`                → exactly these risks, each with its budget (or
 *                           `everything-i-hold`'s); trust levels beside it only
 *                           redraw the form.
 */
export interface DraftAccount {
  readonly account_id?: string;
  readonly service?: string;
  /**
   * Several resource sets on the account (risk model §4.7), each with its
   * resources, trust levels and policy, in order ("Resource set 1", "Resource set
   * 2"). Given, it replaces `resources`, `future`, `env`, `everything_i_hold`,
   * `policy` and `trust_levels`, which then must be absent; absent, those fields are
   * the account's selection, split by environment into one set per environment.
   */
  readonly resource_sets?: readonly DraftResourceSet[];
  /** Default: `{ scope: 'all' }`. */
  readonly resources?: DraftResources;
  /** As `DraftResourceSet.future`, for every set the selection is split into. */
  readonly future?: boolean;
  /** As `DraftResourceSet.env`: the environment of a selection that lists no resource. */
  readonly env?: string | null;
  /**
   * True for the built-in "everything I hold", expanded against the selection
   * (ADR preset-everything-i-hold-expands-explicitly). Absent: false.
   */
  readonly everything_i_hold?: boolean;
  readonly policy?: readonly DraftPolicyEntry[];
  /**
   * The trust level of each ticked macro-action (risk model §4.6). Without
   * `policy`, they write it; with one, they decide nothing. Either way they are
   * kept with the mission only to redraw the form.
   */
  readonly trust_levels?: Readonly<Record<string, string>>;
}

/**
 * One resource set of a draft account (risk model §4.7): the fields an account
 * with one set gives directly. The sets of an account partition its selection: a
 * resource in one set only, and at most one set takes "the rest" (`all` or
 * `account`: every resource no other set selects).
 */
export interface DraftResourceSet {
  /** The stored set an edit keeps (its counters and requests follow it); ignored at issuance. */
  readonly id?: string;
  /** Default: `{ scope: 'all' }`. */
  readonly resources?: DraftResources;
  /**
   * Resources that later appear on the account with the set's environment join its
   * list. Absent: off, except under the legacy `{ scope: 'account' }`.
   */
  readonly future?: boolean;
  /**
   * The set's environment when it lists no resource (a set of future resources only):
   * a label, or `null` for none. Given beside resources, every one must carry it.
   */
  readonly env?: string | null;
  readonly everything_i_hold?: boolean;
  readonly policy?: readonly DraftPolicyEntry[];
  readonly trust_levels?: Readonly<Record<string, string>>;
}

/** The sets of a draft account: `resource_sets`, or the account's own fields as one set. */
export function draftSetsOf(account: DraftAccount): readonly DraftResourceSet[] {
  if (account.resource_sets) return account.resource_sets;
  return [
    {
      ...(account.resources ? { resources: account.resources } : {}),
      ...(account.future !== undefined ? { future: account.future } : {}),
      ...(account.env !== undefined ? { env: account.env } : {}),
      ...(account.everything_i_hold !== undefined
        ? { everything_i_hold: account.everything_i_hold }
        : {}),
      ...(account.policy ? { policy: account.policy } : {}),
      ...(account.trust_levels ? { trust_levels: account.trust_levels } : {}),
    },
  ];
}

export type DraftPeriod =
  { readonly kind: 'one-off' } | { readonly kind: 'recurring'; readonly length_seconds: number };

export interface MissionDraft {
  readonly name: string;
  readonly accounts: readonly DraftAccount[];
  readonly period: DraftPeriod;
  /** ISO-8601 instant, or `null` for a mission that never expires (ADR D4). */
  readonly expires_at: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issuance context — what the creator may build a mission from
// ─────────────────────────────────────────────────────────────────────────────

// The four rows and the reasons are the policy engine's (one tree for the gateway and the site).
export type { Reason, Row } from '@vaubaan/policy-engine';

/** One explicit `RiskId` of a service's catalog, with what the interface shows. */
export interface CatalogRisk {
  readonly risk_id: RiskId;
  /** The catalog entry's id (`supabase.bulk-row-write` for `supabase[staging].bulk-row-write`). */
  readonly base_id: RiskId;
  readonly env: string | null;
  readonly label: string;
  readonly reason: string;
  /** The five facts, resolved for `env` (risk model §4.2): what the row is read from. */
  readonly vector: RiskVector;
  readonly kind: RiskKind;
  /** The row of the decision tree (risk model §4.6): orders, and pre-fills a trust level's gate. */
  readonly row: Row;
  /** The branch of the tree that decided the row; `null` in row 1. */
  readonly row_reason: Reason | null;
  /** The catalog's catch-all (`<service>.uncategorized-write`); only in "Anything else". */
  readonly fallback: boolean;
  readonly deprecated: boolean;
  /** Hard ceiling from the catalog's `infra_limits.calls_per_minute_max`, if any. */
  readonly rate_ceiling_per_minute: number | null;
}

export interface IssuanceResource {
  readonly id: string;
  readonly ref: string;
  readonly display_name: string;
  readonly env: string | null;
  /**
   * Hidden by the account's owner: left out of "all resources", still
   * selectable explicitly.
   */
  readonly hidden: boolean;
  /** No longer returned by discovery: never part of a new mission. */
  readonly stale: boolean;
  /**
   * One of this instance's own resources (`InstanceConfig.selfResources`, SEC
   * 2026-10-15 H1): never part of a mission, whatever the selection says.
   */
  readonly self: boolean;
}

/** An account the creator holds authority on, with everything issuance needs. */
export interface IssuanceAccount {
  readonly id: string;
  readonly service: string;
  readonly service_label: string;
  /** What one resource of this service is called (`resourceNounOf`): "board" / "boards". */
  readonly resource_noun: ResourceNoun;
  readonly display_name: string;
  readonly status: string;
  /**
   * True when the plugin derives the environment from the call itself
   * (`ServicePlugin.envOf`, e.g. Vercel's `env[prod]` segment): its
   * env-qualified risks need no labelled resource to be reachable.
   */
  readonly derives_env: boolean;
  /**
   * The account owner's default environment for resources without a label of
   * their own (ADR connect-driver-and-resource-curation); `null` when none. Already
   * applied to `resources[].env`: nothing reads it to resolve an environment.
   */
  readonly default_env: string | null;
  /**
   * Why the creator holds authority here (spec §3.1): `owner` — theirs, or their
   * group's — or `share`, the union of the shares they receive. `authority` is
   * the exact restriction either way.
   */
  readonly basis: 'owner' | 'share';
  readonly resources: readonly IssuanceResource[];
  /** The whole catalog as explicit ids, catalog order. */
  readonly risks: readonly CatalogRisk[];
  /** The creator's authority on this account: explicit ids, a subset of `risks`. */
  readonly authority: readonly RiskId[];
  /** The catalog's macro-actions, then "Anything else" holding the fallback (`macroActionsOf`). */
  readonly macro_actions: readonly MacroAction[];
}

/**
 * Who prepared a mission for its creator (spec §2.4, §7.10 "marked as prepared by
 * an agent"): the mission whose agent issued it through its Vaubaan account, or —
 * history — the app that issued it by delegation before the management door was
 * retired. `null` everywhere a person issued the mission in the interface.
 */
export interface MissionIssuer {
  /** The issuing mission; `null` for a mission an app issued by delegation. */
  readonly mission_id: string | null;
  /** Its name as it reads now; `null` with no issuing mission. */
  readonly mission_name: string | null;
  /** History: the name the app gave itself (a claim, not verified); `null` otherwise. */
  readonly client_name: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

export const PREVIEW_ISSUE_CODES = [
  'name-missing',
  'no-account',
  'account-unknown',
  'account-ambiguous',
  'account-unavailable',
  'duplicate-account',
  'resource-not-in-account',
  'resource-stale',
  'resource-self',
  'no-resource-selected',
  /**
   * Two resource sets of one account hold the same resource, both take "the rest", or
   * both take the future resources of one environment.
   */
  'resource-sets-overlap',
  /** A resource set holds resources of several environments (a set is one environment). */
  'resource-set-mixed-env',
  /**
   * A resource without an environment label (or a set of future resources without an
   * environment) on a service whose catalog has env-qualified risks.
   */
  'resource-unlabelled',
  /** `resource_sets` beside the account's own `resources`, `policy`, `trust_levels`… */
  'resource-sets-mixed',
  'unknown-macro-action',
  'unknown-risk',
  'duplicate-risk',
  'exceeds-authority',
  'unresolvable-env',
  'missing-budget',
  'invalid-budget',
  'no-accepted-risk',
  'invalid-period',
  'invalid-expiry',
  /** An edit after issuance asks for another period (ADR mission-editable-after-issuance). */
  'period-not-editable',
] as const;
export type PreviewIssueCode = (typeof PREVIEW_ISSUE_CODES)[number];

/** One reason the draft cannot be issued as written. */
export interface PreviewIssue {
  readonly code: PreviewIssueCode;
  readonly message: string;
  /** Index of the draft account the issue is about, when it is about one. */
  readonly account_index?: number;
  readonly account_id?: string;
  /** Index of the resource set of that account (0 for the first), when it is about one. */
  readonly resource_set_index?: number;
  /** The offending ids: for `exceeds-authority`, the uncovered list (spec §3.1). */
  readonly risk_ids?: readonly RiskId[];
  readonly resource_refs?: readonly string[];
}

export const PREVIEW_NOTICE_CODES = [
  'resource-without-env',
  'resource-env-not-in-catalog',
  /** `all` or `account` left out resources without a label (`resource-unlabelled`). */
  'unlabelled-resources-left-out',
  /** A legacy selection was split into one resource set per environment. */
  'split-by-environment',
  'everything-i-hold-expanded',
] as const;
export type PreviewNoticeCode = (typeof PREVIEW_NOTICE_CODES)[number];

/**
 * Something the creator should know about a draft that can be issued as
 * written. A notice never blocks (`MissionPreview.ok` ignores it).
 *
 * Every code is about the same runtime rule: an env-scoped risk touched on a
 * resource whose environment label is absent, or is not one the risk is
 * acceptable in, refuses the call (`risk-not-accepted`) whatever the mission
 * accepts. On such a resource the mission therefore reaches the account-scoped
 * risks only.
 *
 * `unlabelled-resources-left-out` and `split-by-environment` say what the
 * normalization of a legacy selection did (`DraftResources`).
 *
 * `everything-i-hold-expanded` is of another kind: it says what the built-in
 * expansion `everything-i-hold` wrote out on an account — how many explicit
 * lines, the hardest to repair, those that cannot be repaired running freely and the fallback,
 * whose ids are its `risk_ids` (ADR preset-everything-i-hold-expands-explicitly).
 */
export interface PreviewNotice {
  readonly code: PreviewNoticeCode;
  readonly message: string;
  readonly account_index?: number;
  readonly account_id?: string;
  readonly resource_set_index?: number;
  /** The selected resources the notice is about. */
  readonly resource_refs: readonly string[];
  /**
   * The env-scoped ids the draft accepts on this account, unreachable on those
   * resources; for `everything-i-hold-expanded`, the critical ids that run freely
   * and the fallback.
   */
  readonly risk_ids: readonly RiskId[];
}

export interface UnresolvableEntry {
  readonly risk_id: RiskId;
  /** The environment no selected resource carries. */
  readonly env: string;
}

/**
 * A risk the trust levels or `everything-i-hold` would have written that the policy
 * leaves out: outside the creator's authority, no selected resource in its
 * environment, or (`trust-level`) a row the trust level does not accept.
 */
export interface LeftOutEntry {
  readonly risk_id: RiskId;
  readonly reason: 'outside-authority' | 'unresolvable-env' | 'trust-level';
  readonly env: string | null;
}

/** What the draft yields on one resource set of an account (risk model §4.7). */
export interface ResourceSetPreview {
  /** Its place among the sets of the account, from 0. */
  readonly index: number;
  /** The stored set an edit keeps; `null` for a set the draft adds. */
  readonly id: string | null;
  /** The resources of the set as it would be stored. */
  readonly resources: readonly IssuanceResource[];
  /** Resources that later appear in `env` join the set. */
  readonly future: boolean;
  /** The set's environment: the label every resource carries; `null` for none. */
  readonly env: string | null;
  readonly everything_i_hold: boolean;
  readonly passes: readonly MissionPolicyEntry[];
  readonly exceeds: readonly RiskId[];
  readonly unknown: readonly RiskId[];
  readonly unresolvable: readonly UnresolvableEntry[];
  readonly missing_budget: readonly RiskId[];
  readonly left_out: readonly LeftOutEntry[];
  readonly trust_levels: Readonly<Record<string, TrustLevel>>;
}

/**
 * What the draft yields on one account. With one resource set, the account's
 * fields are that set's; with several, they are the sets' together (`passes` lists
 * each set's lines) and `resource_sets` tells them apart.
 */
export interface AccountPreview {
  readonly account_id: string;
  readonly service: string;
  readonly display_name: string;
  /** The resources the mission would be persisted with, every set together. */
  readonly resources: readonly IssuanceResource[];
  /** One set at least takes the resources that later appear in its environment. */
  readonly future: boolean;
  /** Size of "all resources" on this account, plus the hidden ones selected explicitly. */
  readonly resources_total: number;
  /** The built-in "everything I hold" wrote (or budgets) this account's lines. */
  readonly everything_i_hold: boolean;
  /** Accepted, inside the authority, resolvable, with a resolved budget. */
  readonly passes: readonly MissionPolicyEntry[];
  /** Accepted but outside the creator's authority — the uncovered list. */
  readonly exceeds: readonly RiskId[];
  /** Not an explicit id of this account's catalog. */
  readonly unknown: readonly RiskId[];
  /** Env-qualified entries whose environment no selected resource carries. */
  readonly unresolvable: readonly UnresolvableEntry[];
  readonly missing_budget: readonly RiskId[];
  /**
   * What the trust levels or `everything-i-hold` left out when they write the policy
   * (no explicit `policy`): they inform, they do not block.
   */
  readonly left_out: readonly LeftOutEntry[];
  /** The draft's trust levels that name a macro-action of the account (`knownTrustLevels`). */
  readonly trust_levels: Readonly<Record<string, TrustLevel>>;
  /** Each set of the account, in order; one for an account given without sets. */
  readonly resource_sets: readonly ResourceSetPreview[];
}

/** The three lines of spec §4.2: what the mission can do, cannot do, in what quantity. */
export interface MissionSummaryLines {
  readonly can: string;
  readonly cannot: string;
  readonly quantities: string;
}

/**
 * The draft with every alias resolved (account ids, resource ids, explicit entries)
 * and every set split to one environment.
 */
export interface ResolvedDraftAccount {
  readonly account_id: string;
  /** The sets of the account, in order. */
  readonly resource_sets: readonly ResolvedDraftSet[];
}

/** One set of a resolved draft account. */
export interface ResolvedDraftSet {
  /** The stored set an edit keeps; absent for a new set. */
  readonly id?: string;
  readonly resources: { readonly scope: 'selected'; readonly resource_ids: readonly string[] };
  readonly future: boolean;
  readonly env: string | null;
  readonly everything_i_hold: boolean;
  readonly policy: readonly MissionPolicyEntry[];
  /** The draft's trust levels that name a macro-action of the account. */
  readonly trust_levels: Readonly<Record<string, TrustLevel>>;
}

export interface MissionPreview {
  /** True when `issue()` would accept this draft unchanged. */
  readonly ok: boolean;
  readonly issues: readonly PreviewIssue[];
  /** What the creator should know although the draft passes; never blocks. */
  readonly notices: readonly PreviewNotice[];
  readonly name: string;
  readonly accounts: readonly AccountPreview[];
  /** What becomes callable: the mission policy as it would be persisted. */
  readonly policy: readonly MissionPolicyEntry[];
  readonly period: DraftPeriod;
  readonly expires_at: string | null;
  readonly summary: MissionSummaryLines;
  /** The passing part of the draft, aliases resolved — what a form loads from a proposal. */
  readonly resolved: readonly ResolvedDraftAccount[];
}
