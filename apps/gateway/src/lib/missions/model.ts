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
import type { TrustLevel } from '@vaubaan/policy-engine';
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
 * omitted when the connection names `everything-i-hold`: they then come from
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
 * The resources a mission may touch on one connection (spec §3.1 "Resource
 * selection"):
 *
 * - `all` is resolved at issuance to the resources known then — the ones the
 *   owner did not hide and discovery still returns — and persisted as that
 *   explicit list: a resource discovered later is not covered;
 * - `connection` is the whole connection, resources discovered later
 *   included (hidden ones excepted), resolved each time the mission is read —
 *   only ever chosen explicitly (ADR
 *   mission-reaches-the-whole-connection-on-request);
 * - `selected` names resources by id (the interface) or by ref (an agent's
 *   proposal, which only knows refs).
 */
export type DraftResources =
  | { readonly scope: 'all' }
  | { readonly scope: 'connection' }
  | {
      readonly scope: 'selected';
      readonly resource_ids?: readonly string[];
      readonly resource_refs?: readonly string[];
    };

/**
 * One connection of a draft with its partition of the policy (spec §3.1 "A
 * multi-connection mission composes its authority connection by connection").
 *
 * The connection is named by id, or by `provider` when the creator holds
 * exactly one usable connection of that provider (an agent's proposal).
 *
 * `trust levels` + no `policy`   → what the macro-actions write at their trust levels,
 *                           bounded by the authority and the selection.
 * `everything-i-hold`     → every risk held there that the selection reaches.
 * `policy`                → exactly these risks, each with its budget (or
 *                           `everything-i-hold`'s); trust levels beside it only
 *                           redraw the form.
 */
export interface DraftConnection {
  readonly connection_id?: string;
  readonly provider?: string;
  /**
   * Several resource sets on the connection (risk model §4.7), each with its
   * resources, trust levels and policy, in order ("Resource set 1", "Resource set
   * 2"). Given, it replaces `resources`, `everything_i_hold`, `policy` and
   * `trust_levels`, which then must be absent; absent, those four fields are the
   * connection's one set.
   */
  readonly resource_sets?: readonly DraftResourceSet[];
  /** Default: `{ scope: 'all' }`. */
  readonly resources?: DraftResources;
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
 * One resource set of a draft connection (risk model §4.7): the fields a connection
 * with one set gives directly. The sets of a connection partition its selection: a
 * resource in one set only, and at most one set takes "the rest" (`all` or
 * `connection`: every resource no other set selects).
 */
export interface DraftResourceSet {
  /** The stored set an edit keeps (its counters and requests follow it); ignored at issuance. */
  readonly id?: string;
  /** Default: `{ scope: 'all' }`. */
  readonly resources?: DraftResources;
  readonly everything_i_hold?: boolean;
  readonly policy?: readonly DraftPolicyEntry[];
  readonly trust_levels?: Readonly<Record<string, string>>;
}

/** The sets of a draft connection: `resource_sets`, or the connection's own fields as one set. */
export function draftSetsOf(connection: DraftConnection): readonly DraftResourceSet[] {
  if (connection.resource_sets) return connection.resource_sets;
  return [
    {
      ...(connection.resources ? { resources: connection.resources } : {}),
      ...(connection.everything_i_hold !== undefined
        ? { everything_i_hold: connection.everything_i_hold }
        : {}),
      ...(connection.policy ? { policy: connection.policy } : {}),
      ...(connection.trust_levels ? { trust_levels: connection.trust_levels } : {}),
    },
  ];
}

export type DraftPeriod =
  { readonly kind: 'one-off' } | { readonly kind: 'recurring'; readonly length_seconds: number };

export interface MissionDraft {
  readonly name: string;
  readonly connections: readonly DraftConnection[];
  readonly period: DraftPeriod;
  /** ISO-8601 instant, or `null` for a mission that never expires (ADR D4). */
  readonly expires_at: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issuance context — what the creator may build a mission from
// ─────────────────────────────────────────────────────────────────────────────

export const SEVERITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

/**
 * What an entry does, in three words a creator sorts by: it only reads, it
 * writes, or it writes something that cannot be undone. Derived from the
 * entry's patterns (all end in `.R`) and from the `reversibility` axis of its
 * vector; a way to group a long catalog, never a decision.
 */
export const RISK_KINDS = ['read', 'write', 'destructive'] as const;
export type RiskKind = (typeof RISK_KINDS)[number];

/** One explicit `RiskId` of a provider's catalog, with what the interface shows. */
export interface CatalogRisk {
  readonly risk_id: RiskId;
  /** The catalog entry's id (`supabase.bulk-row-write` for `supabase[staging].bulk-row-write`). */
  readonly base_id: RiskId;
  readonly env: string | null;
  readonly label: string;
  readonly reason: string;
  /** The six-axis profile, resolved for `env` (risk model §4.2): it explains, it decides nothing. */
  readonly vector: RiskVector;
  readonly kind: RiskKind;
  /** Ordering signal derived from the 6-D vector; never a gate (risk model §3). */
  readonly severity: number;
  readonly level: SeverityLevel;
  /** The catalog's catch-all (`<provider>.uncategorized-write`); only in "Anything else". */
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
   * Hidden by the connection's owner: left out of "all resources", still
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

/** A connection the creator holds authority on, with everything issuance needs. */
export interface IssuanceConnection {
  readonly id: string;
  readonly provider: string;
  readonly provider_label: string;
  readonly display_name: string;
  readonly status: string;
  /**
   * True when the plugin derives the environment from the call itself
   * (`ProviderPlugin.envOf`, e.g. Vercel's `env[prod]` segment): its
   * env-qualified risks need no labelled resource to be reachable.
   */
  readonly derives_env: boolean;
  /**
   * The connection owner's default environment for resources without a label of
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
  /** The creator's authority on this connection: explicit ids, a subset of `risks`. */
  readonly authority: readonly RiskId[];
  /** The catalog's macro-actions, then "Anything else" holding the fallback (`macroActionsOf`). */
  readonly macro_actions: readonly MacroAction[];
}

/**
 * The client that issued a mission through the management door, on behalf of
 * its creator (spec §2.4, §7.10 "marked as delegated"). `null` everywhere a
 * mission was issued in the interface.
 */
export interface MissionIssuer {
  readonly delegation_id: string;
  /** The OAuth client's public id, as the audit names it (`delegated_client_id`). */
  readonly client_id: string;
  /** The name the client gave itself: a claim, not verified. */
  readonly client_name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

export const PREVIEW_ISSUE_CODES = [
  'name-missing',
  'no-connection',
  'connection-unknown',
  'connection-ambiguous',
  'connection-unavailable',
  'duplicate-connection',
  'duplicate-provider',
  'resource-not-in-connection',
  'resource-stale',
  'resource-self',
  'no-resource-selected',
  /** Two resource sets of one connection hold the same resource, or both take "the rest". */
  'resource-sets-overlap',
  /** `resource_sets` beside the connection's own `resources`, `policy`, `trust_levels`… */
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
  /** Index of the draft connection the issue is about, when it is about one. */
  readonly connection_index?: number;
  readonly connection_id?: string;
  /** Index of the resource set of that connection (0 for the first), when it is about one. */
  readonly resource_set_index?: number;
  /** The offending ids: for `exceeds-authority`, the uncovered list (spec §3.1). */
  readonly risk_ids?: readonly RiskId[];
  readonly resource_refs?: readonly string[];
}

export const PREVIEW_NOTICE_CODES = [
  'resource-without-env',
  'resource-env-not-in-catalog',
  'later-resources-need-env-label',
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
 * risks only. `later-resources-need-env-label` says it of the resources a
 * whole-connection mission (scope `connection`) will reach after issuance:
 * checked against the resources known now, the mission reaches env-scoped
 * permissions on a later one only once it is labelled (`resource_refs` empty).
 *
 * `everything-i-hold-expanded` is of another kind: it says what the built-in
 * expansion `everything-i-hold` wrote out on a connection — how many explicit
 * lines, the most severe, the critical ones running freely and the fallback,
 * whose ids are its `risk_ids` (ADR preset-everything-i-hold-expands-explicitly).
 */
export interface PreviewNotice {
  readonly code: PreviewNoticeCode;
  readonly message: string;
  readonly connection_index?: number;
  readonly connection_id?: string;
  readonly resource_set_index?: number;
  /** The selected resources the notice is about. */
  readonly resource_refs: readonly string[];
  /**
   * The env-scoped ids the draft accepts on this connection, unreachable on those
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
 * environment, or (`trust-level`) a tier the trust level does not accept.
 */
export interface LeftOutEntry {
  readonly risk_id: RiskId;
  readonly reason: 'outside-authority' | 'unresolvable-env' | 'trust-level';
  readonly env: string | null;
}

/** What the draft yields on one resource set of a connection (risk model §4.7). */
export interface ResourceSetPreview {
  /** Its place among the sets of the connection, from 0. */
  readonly index: number;
  /** The stored set an edit keeps; `null` for a set the draft adds. */
  readonly id: string | null;
  /** The resources of the set as it would be stored; for `connection`, the ones it reaches now. */
  readonly resources: readonly IssuanceResource[];
  /** True for scope `connection`: the resources no other set selects, later ones included. */
  readonly reaches_later: boolean;
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
 * What the draft yields on one connection. With one resource set, the connection's
 * fields are that set's; with several, they are the sets' together (`passes` lists
 * each set's lines) and `resource_sets` tells them apart.
 */
export interface ConnectionPreview {
  readonly connection_id: string;
  readonly provider: string;
  readonly display_name: string;
  /**
   * The resources the mission would be persisted with (explicit, even for `all`);
   * for `connection`, the ones it reaches now — later ones join them.
   */
  readonly resources: readonly IssuanceResource[];
  /** True for scope `connection`: resources discovered after issuance are reached too. */
  readonly reaches_later: boolean;
  /** Size of "all resources" on this connection, plus the hidden ones selected explicitly. */
  readonly resources_total: number;
  /** The built-in "everything I hold" wrote (or budgets) this connection's lines. */
  readonly everything_i_hold: boolean;
  /** Accepted, inside the authority, resolvable, with a resolved budget. */
  readonly passes: readonly MissionPolicyEntry[];
  /** Accepted but outside the creator's authority — the uncovered list. */
  readonly exceeds: readonly RiskId[];
  /** Not an explicit id of this connection's catalog. */
  readonly unknown: readonly RiskId[];
  /** Env-qualified entries whose environment no selected resource carries. */
  readonly unresolvable: readonly UnresolvableEntry[];
  readonly missing_budget: readonly RiskId[];
  /**
   * What the trust levels or `everything-i-hold` left out when they write the policy
   * (no explicit `policy`): they inform, they do not block.
   */
  readonly left_out: readonly LeftOutEntry[];
  /** The draft's trust levels that name a macro-action of the connection (`knownTrustLevels`). */
  readonly trust_levels: Readonly<Record<string, TrustLevel>>;
  /** Each set of the connection, in order; one for a connection given without sets. */
  readonly resource_sets: readonly ResourceSetPreview[];
}

/** The three lines of spec §4.2: what the mission can do, cannot do, in what quantity. */
export interface MissionSummaryLines {
  readonly can: string;
  readonly cannot: string;
  readonly quantities: string;
}

/**
 * The draft with every alias resolved (connection ids, resource ids, explicit entries).
 * `connection` stays a scope: what it reaches is read when the mission is read.
 */
export interface ResolvedDraftConnection {
  readonly connection_id: string;
  /** The sets of the connection, in order. */
  readonly resource_sets: readonly ResolvedDraftSet[];
}

/** One set of a resolved draft connection. */
export interface ResolvedDraftSet {
  /** The stored set an edit keeps; absent for a new set. */
  readonly id?: string;
  readonly resources:
    | { readonly scope: 'selected'; readonly resource_ids: readonly string[] }
    | { readonly scope: 'connection' };
  readonly everything_i_hold: boolean;
  readonly policy: readonly MissionPolicyEntry[];
  /** The draft's trust levels that name a macro-action of the connection. */
  readonly trust_levels: Readonly<Record<string, TrustLevel>>;
}

export interface MissionPreview {
  /** True when `issue()` would accept this draft unchanged. */
  readonly ok: boolean;
  readonly issues: readonly PreviewIssue[];
  /** What the creator should know although the draft passes; never blocks. */
  readonly notices: readonly PreviewNotice[];
  readonly name: string;
  readonly connections: readonly ConnectionPreview[];
  /** What becomes callable: the mission policy as it would be persisted. */
  readonly policy: readonly MissionPolicyEntry[];
  readonly period: DraftPeriod;
  readonly expires_at: string | null;
  readonly summary: MissionSummaryLines;
  /** The passing part of the draft, aliases resolved — what a form loads from a proposal. */
  readonly resolved: readonly ResolvedDraftConnection[];
}
