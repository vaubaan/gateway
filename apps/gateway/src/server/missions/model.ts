/**
 * Vocabulary of mission issuance: the draft a creator (or, later, an agent on
 * the management door) submits, the issuance context it is checked against,
 * and the preview that says what passes.
 *
 * Wire shapes are snake_case like the shared domain (`MissionPolicyEntry`),
 * because the same draft and preview are exposed as-is on the management door
 * (spec §4.1 bis, plan P2.4). Types only: this file is safe to import from a
 * client component.
 */
import type { Gate, MissionPolicyEntry, Preset, RateLimit, RiskId } from '@vaubaan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Draft
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One accepted risk of a draft. `quota`, `rate_limit` and `gate` may be
 * omitted: they then come from the connection's preset entry for that risk.
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
 * The resources a mission may touch on one connection. `all` is resolved at
 * issuance to the resources known then — the ones the owner did not hide and
 * discovery still returns — and persisted as that explicit list:
 * a resource discovered later is not covered (spec §3.1 "Resource selection").
 * A selection names resources by id (the interface) or by ref (an agent's
 * proposal, which only knows refs).
 */
export type DraftResources =
  | { readonly scope: 'all' }
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
 * `preset` + no `policy`  → the preset's entries, bounded by the authority.
 * `policy`                → exactly these risks; a missing budget falls back
 *                           to the preset's entry for the same risk.
 */
export interface DraftConnection {
  readonly connection_id?: string;
  readonly provider?: string;
  /** Default: `{ scope: 'all' }`. */
  readonly resources?: DraftResources;
  /** Preset id of the connection's plugin (`registry.presetsOf`). */
  readonly preset?: string | null;
  readonly policy?: readonly DraftPolicyEntry[];
}

export type DraftPeriod =
  | { readonly kind: 'one-off' }
  | { readonly kind: 'recurring'; readonly length_seconds: number };

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

/** One explicit `RiskId` of a provider's catalog, with what the interface shows. */
export interface CatalogRisk {
  readonly risk_id: RiskId;
  /** The catalog entry's id (`supabase.bulk-row-write` for `supabase[staging].bulk-row-write`). */
  readonly base_id: RiskId;
  readonly env: string | null;
  readonly label: string;
  readonly reason: string;
  /** Ordering signal derived from the 6-D vector; never a gate (risk model §3). */
  readonly severity: number;
  readonly level: SeverityLevel;
  /** The catalog's catch-all (`<provider>.uncategorized-write`); never in a preset. */
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
}

/** A connection the creator holds authority on, with everything issuance needs. */
export interface IssuanceConnection {
  readonly id: string;
  readonly provider: string;
  readonly provider_label: string;
  readonly display_name: string;
  readonly status: string;
  /** `ProviderPlugin.experimental`: hidden from issuance unless the creator asks. */
  readonly experimental: boolean;
  /**
   * True when the plugin derives the environment from the call itself
   * (`ProviderPlugin.envOf`, e.g. Vercel's `env[prod]` segment): its
   * env-qualified risks need no labelled resource to be reachable.
   */
  readonly derives_env: boolean;
  readonly resources: readonly IssuanceResource[];
  /** The whole catalog as explicit ids, catalog order. */
  readonly risks: readonly CatalogRisk[];
  /** The creator's authority on this connection: explicit ids, a subset of `risks`. */
  readonly authority: readonly RiskId[];
  readonly presets: readonly Preset[];
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
  'no-resource-selected',
  'unknown-preset',
  'unknown-risk',
  'duplicate-risk',
  'exceeds-authority',
  'unresolvable-env',
  'missing-budget',
  'invalid-budget',
  'no-accepted-risk',
  'invalid-period',
  'invalid-expiry',
] as const;
export type PreviewIssueCode = (typeof PREVIEW_ISSUE_CODES)[number];

/** One reason the draft cannot be issued as written. */
export interface PreviewIssue {
  readonly code: PreviewIssueCode;
  readonly message: string;
  /** Index of the draft connection the issue is about, when it is about one. */
  readonly connection_index?: number;
  readonly connection_id?: string;
  /** The offending ids: for `exceeds-authority`, the uncovered list (spec §3.1). */
  readonly risk_ids?: readonly RiskId[];
  readonly resource_refs?: readonly string[];
}

export const PREVIEW_NOTICE_CODES = [
  'resource-without-env',
  'resource-env-not-in-catalog',
] as const;
export type PreviewNoticeCode = (typeof PREVIEW_NOTICE_CODES)[number];

/**
 * Something the creator should know about a draft that can be issued as
 * written. A notice never blocks (`MissionPreview.ok` ignores it).
 *
 * Both codes are about the same runtime rule: an env-scoped risk touched on a
 * resource whose environment label is absent, or is not one the risk is
 * acceptable in, refuses the call (`risk-not-accepted`) whatever the mission
 * accepts. On such a resource the mission therefore reaches the account-scoped
 * risks only.
 */
export interface PreviewNotice {
  readonly code: PreviewNoticeCode;
  readonly message: string;
  readonly connection_index?: number;
  readonly connection_id?: string;
  /** The selected resources the notice is about. */
  readonly resource_refs: readonly string[];
  /** The env-scoped ids the draft accepts on this connection, unreachable on those resources. */
  readonly risk_ids: readonly RiskId[];
}

export interface UnresolvableEntry {
  readonly risk_id: RiskId;
  /** The environment no selected resource carries. */
  readonly env: string;
}

export interface SkippedPresetEntry {
  readonly risk_id: RiskId;
  readonly reason: 'outside-authority' | 'unresolvable-env';
  readonly env: string | null;
}

/** What the draft yields on one connection. */
export interface ConnectionPreview {
  readonly connection_id: string;
  readonly provider: string;
  readonly display_name: string;
  /** The resources the mission would be persisted with (explicit, even for `all`). */
  readonly resources: readonly IssuanceResource[];
  /** Size of "all resources" on this connection, plus the hidden ones selected explicitly. */
  readonly resources_total: number;
  readonly preset: { readonly id: string; readonly label: string } | null;
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
   * Preset entries left out when the preset is applied as is (no explicit
   * policy): they inform, they do not block.
   */
  readonly skipped_from_preset: readonly SkippedPresetEntry[];
}

/** The three lines of spec §4.2: what the mission can do, cannot do, in what quantity. */
export interface MissionSummaryLines {
  readonly can: string;
  readonly cannot: string;
  readonly quantities: string;
}

/** The draft with every alias resolved (connection ids, resource ids, explicit entries). */
export interface ResolvedDraftConnection {
  readonly connection_id: string;
  readonly resources: { readonly scope: 'selected'; readonly resource_ids: readonly string[] };
  readonly preset: string | null;
  readonly policy: readonly MissionPolicyEntry[];
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
