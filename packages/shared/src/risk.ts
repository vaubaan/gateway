/**
 * Risk-based authorization types.
 *
 * Spec : docs/spec/gateway-risk-model.md (slices, catalogs, 6-D vector,
 *        scope caps) ; docs/spec/vaubaan-gateway.md §3.2 (presets).
 * ADR  : docs/decisions/unified-gates-drop-confirm.md,
 *        docs/decisions/plugin-contract-and-credential-spec.md.
 *
 * A mission does not carry capabilities ; it carries a policy keyed by
 * *accepted risks* (`RiskId`), each with a budget and a gate. The plugin's
 * `classify(tool, args, resources)` returns the `Slice` values a call
 * touches ; the provider's risk catalog (YAML, loaded at boot) maps slice
 * patterns to `RiskEntry` entries. The runtime intersects the executed
 * slices with the catalog, derives the touched `RiskId[]`, and authorizes
 * only if that set is a subset of the mission's accepted risks — the budget
 * and gate checks come after. There is no intermediate gate at this stage :
 * a risk is either accepted or not.
 *
 * This module is the **type-only** contract. Logic lives in
 * `@vaubaan/policy-engine` ; catalog loading in `@vaubaan/plugin-sdk`.
 */

import type { Budget, Gate } from './domain.ts';
import type { RefusalCode } from './refusal.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Slice — the path-based selector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A slice = a path on the provider's data-model + an action.
 *
 * Path segments can be :
 *   - `ident`  : an exact identifier (e.g. `main`, `feature/auth-bug`,
 *                `sbw-vaubaan/gateway`)
 *   - `list`   : a finite list of identifiers (e.g. `[main,develop]`)
 *   - `wild`   : `*` (one segment) or `**` (recursive zero-or-more)
 *
 * The first segment is always the provider id (`github`, `vercel`, ...).
 *
 * Example serializations (wire form, used in catalog YAML and audit logs) :
 *   - `github.repo[sbw-vaubaan/gateway].branch[main].W`
 *   - `supabase.project[*].schema[public].table[*].row[*].R`
 *   - `vercel.project[gateway].env[prod].env-var[NEXT_PUBLIC_*].W`
 *
 * Grammar :
 *   slice    ::= provider '.' segment ('.' segment)* '.' action
 *   provider ::= ident
 *   segment  ::= ident | '[' inner ']'
 *   inner    ::= '*' | '**' | ident (',' ident)*
 *   ident    ::= [a-zA-Z0-9_./~-]+ (allows '/' for refs like 'owner/repo',
 *                                   '.' and '~' for file names and git refs)
 *   action   ::= 'R' | 'W'
 *
 * The asterisk in an `ident` segment (e.g. `[NEXT_PUBLIC_*]`) acts as a
 * glob over the same identifier characters. The bare `[*]` matches any single segment ;
 * `[**]` matches zero or more segments. No regex.
 */
export interface Slice {
  /** Provider id (first path segment). Examples : 'github', 'vercel'. */
  readonly provider: string;
  /** Path segments after the provider. Each is a name, list, or wildcard.
   *  See {@link SliceSegment}. */
  readonly path: readonly SliceSegment[];
  /** Read or Write. Discriminates the action on the leaf of the path. */
  readonly action: SliceAction;
}

export type SliceAction = 'R' | 'W';

/** One segment of a slice path. */
export type SliceSegment =
  /** Exact entity name (e.g. `branch`, `file`) — appears unbracketed. */
  | { readonly kind: 'name'; readonly value: string }
  /** Bracketed identifier (e.g. `[main]`). Glob `*` accepted inside. */
  | { readonly kind: 'ident'; readonly value: string }
  /** Bracketed list of identifiers (e.g. `[main,develop]`). No globs in items. */
  | { readonly kind: 'list'; readonly values: readonly string[] }
  /** `[*]` — wildcard for a single segment. */
  | { readonly kind: 'wild-one' }
  /** `[**]` — recursive wildcard, zero or more segments. */
  | { readonly kind: 'wild-rec' };

// ─────────────────────────────────────────────────────────────────────────────
// Risk vector — 6D, attached to catalog entries (not to missions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 6 orthogonal risk axes synthesized from OWASP LLM06, NIST AI RMF
 * Agentic Profile, MITRE ATLAS v5.1, Five Eyes 2026-05, Anthropic RSP v3.
 *
 * Used to :
 *  - explain a risk in the UI / audit / docs (`reason` field is the
 *    natural-language version of the vector).
 *  - inform the mission creator's decision when they accept a risk.
 *  - drive a visual ordering by severity in the issuance UI (the only
 *    derived signal — no functional gate is computed from this).
 */
/** Allowed values per axis — the one source for the type, YAML validation and UI pickers. */
export const RISK_VECTOR_AXES = {
  reversibility: ['reversible', 'costly', 'irreversible'],
  blast: ['single', 'env', 'account', 'bulk'],
  data: ['metadata', 'data', 'secret', 'pii'],
  cost: ['free', 'moderate', 'unbounded'],
  visibility: ['internal', 'team', 'public'],
  persistence: ['stateless', 'session', 'posture'],
} as const;

export type RiskVector = {
  readonly [K in keyof typeof RISK_VECTOR_AXES]: (typeof RISK_VECTOR_AXES)[K][number];
};

// ─────────────────────────────────────────────────────────────────────────────
// Risk identifier and catalog entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable, version-controlled identifier for a risk.
 *
 * Format (cf. ADR `pivot-to-risk-based-model` §D2, parser in `risk-id.ts`) :
 *   - Env-scoped     : `<provider>[<env>].<name>`
 *     ex: `supabase[staging].bulk-row-write`, `vercel[prod].env-var-write`
 *   - Account-scoped : `<provider>.<name>`
 *     ex: `github.mint-install-token`, `vercel.deploy`
 */
export type RiskId = string;

/**
 * One entry in a provider's risk catalog (declared in
 * `plugins/<provider>/src/risk-catalog.yaml`, loaded at boot).
 *
 * Each entry represents a named business intent ("write env vars on prod",
 * "merge to a protected branch", ...). The `matches` pattern is a slice
 * pattern (same grammar as Slice but allowed to contain `*`/`**` more
 * liberally). When a runtime slice is `intersect`-compatible with the
 * pattern, the entry is added to `risks_touched`.
 *
 * `acceptable_in_envs` (optional) is a *catalog-level* restriction : a risk
 * declared `acceptable_in_envs: ['staging']` cannot be accepted for a
 * resource labelled `prod`. It is the only structural guardrail — the
 * mission creator cannot override it at issuance.
 */
export interface RiskEntry {
  /** Stable, version-controlled identifier. See {@link RiskId}. */
  readonly id: RiskId;
  /** Short human-readable label (UI). */
  readonly label: string;
  /** ≤ 2 sentences explaining why this is a risk. Goes in tooltips and
   *  audit displays. */
  readonly reason: string;
  /** Slice pattern(s) — single string or array of disjoint patterns
   *  (a risk can have multiple patterns when no single pattern can
   *  capture its surface). All patterns are parsed at catalog load. */
  readonly matches: string | readonly string[];
  /** 6D vector explaining the risk's profile. Drives UI ordering and
   *  audit explainability only — no gate is derived from it.
   *  When `vector_overrides` is present this is the default (non-prod)
   *  profile ; per-env overrides replace individual axes. */
  readonly vector: RiskVector;
  /** Per-env vector overrides. Keys are env labels (e.g. `'prod'`),
   *  values contain only the axes that differ from `vector`. Resolved
   *  via `resolveVector(entry, env)` in `@vaubaan/policy-engine`. */
  readonly vector_overrides?: Readonly<Record<string, Partial<RiskVector>>>;
  /** When present, restricts which environment labels can ever accept
   *  this risk. E.g. ['preview', 'staging'] = never acceptable on a
   *  resource labelled 'prod'. Enforced at issuance. */
  readonly acceptable_in_envs?: readonly string[];
  /** Soft default caps (ScopeCaps) the catalog suggests ; a mission may
   *  only tighten them. Optional — absent ≡ no cap suggested.
   *  Cf. ADR scope-caps-amplification-axis §D1. */
  readonly caps?: ScopeCaps;
  /** Hard infra ceilings — never overrideable by a share or a mission.
   *  Optional — absent ≡ no hard ceiling. Cf. ADR scope-caps §D2. */
  readonly infra_limits?: InfraLimits;
  /** Marks the catalog's catch-all entry (`<provider>.uncategorized-write`).
   *  The fallback is touched only when no other entry of the catalog matches
   *  the slice (ADR fallback-risk-only-when-uncategorized). Exactly one per
   *  catalog ; when the flag is absent the engine detects the fallback by
   *  its catch-all pattern (`<provider>.**.W`) or its `uncategorized-` id. */
  readonly fallback?: boolean;
  /** When true, the entry is kept for backward compatibility but should not
   *  be offered in new missions. UI displays a "deprecated" badge. */
  readonly deprecated?: boolean;
  /** When `deprecated`, the replacement risk id (informational). */
  readonly replaced_by?: RiskId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope caps — ADR scope-caps-amplification-axis (accepted 2026-06-17)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Soft scope caps — defaults the catalog suggests, which a share or a
 * mission may only tighten. They express a posture ; they are NOT physical
 * limits (`InfraLimits` are). All fields optional ; absent ≡ no cap on that
 * axis at the level carrying the value.
 *
 * The mission-level `rate_limit` (spec §3.2) is the v5 instantiation of
 * `calls_per_minute_max` : one speed mechanism, the mission sets its value,
 * bounded by the catalog.
 */
export interface ScopeCaps {
  /** Temporal window in days : the agent can only reach items created /
   *  modified within the last N days. The plugin injects the constraint
   *  upstream when the provider supports it (`q: newer_than:Nd`,
   *  `?since=...`), otherwise the call is refused. */
  readonly temporal_window_days?: number;
  /** Items per call ceiling — the agent cannot demand / touch more than N
   *  items in a single tool call. The plugin caps the relevant upstream
   *  arg (`pageSize`, `?per_page=`, `LIMIT N`). */
  readonly items_per_call_max?: number;
  /** Bytes per call ceiling — for payload-variable tools (attachments,
   *  runtime logs, storage objects). Optional — not all tools carry a
   *  meaningful byte size. */
  readonly bytes_per_call_max?: number;
  /** Stateful : calls per rolling minute on the scope holding the cap.
   *  Counted by the gateway behind a rate-limit interface. */
  readonly calls_per_minute_max?: number;
  /** Stateful : cumulative calls over the lifetime of one mission session. */
  readonly calls_per_session_max?: number;
}

/**
 * Hard infra ceilings — imposed by the plugin maintainer for technical or
 * operational reasons (memory budget, upstream provider hard caps).
 * **Never overrideable** at any level (share, mission). Same shape as
 * `ScopeCaps` ; the distinction is in *who can modify* them.
 */
export interface InfraLimits {
  readonly temporal_window_days?: number;
  readonly items_per_call_max?: number;
  readonly bytes_per_call_max?: number;
  readonly calls_per_minute_max?: number;
  readonly calls_per_session_max?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Presets — policy fragments shipped by the plugin (spec §0, §3.2)
// ─────────────────────────────────────────────────────────────────────────────

/** One line of a preset : a risk of the plugin's own catalog with default values. */
export interface PresetEntry extends Budget {
  /** Account-scoped or env-scoped id ; must resolve to an entry of the same catalog. */
  readonly risk_id: RiskId;
  readonly gate: Gate;
}

/**
 * A named policy fragment. UI sugar : it pre-fills the policy of a mission
 * for one connection, the creator adjusts, and the persisted policy is the
 * explicit enumeration. A preset never grants anything by itself and is
 * bounded by the creator's authority at issuance.
 */
export interface Preset {
  /** Slug, unique within the catalog (`reviewer`, `developer`, `release-manager`). */
  readonly id: string;
  readonly label: string;
  /** One line shown next to the label. */
  readonly description: string;
  readonly entries: readonly PresetEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A provider's full risk catalog. `presets` is optional on the type so the
 * not-yet-migrated v4 TS twins still compile ; the SDK loader and
 * `definePlugin` require at least one preset (spec §10).
 */
export interface RiskCatalog {
  readonly provider: string;
  readonly risks: readonly RiskEntry[];
  readonly presets?: readonly Preset[];
  /** Monotonic integer bumped on every reviewed change of the YAML. */
  readonly catalog_version?: number;
  /** ISO date of the last reviewed change. */
  readonly catalog_date?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-call evaluation result
// ─────────────────────────────────────────────────────────────────────────────

/** Output of the risk step of the runtime decision at `tools/call`. */
export type RiskDecision =
  | { readonly outcome: 'allowed'; readonly risks_touched: readonly RiskId[] }
  | {
      readonly outcome: 'denied';
      /** The structured refusal code the gateway returns for this denial.
       *  The risk step only ever emits `risk-not-accepted` ; the field
       *  exists so the audit entry and the refusal body never guess. */
      readonly code: Extract<RefusalCode, 'risk-not-accepted'>;
      /** Risks the call touched but the mission did not accept. */
      readonly missing_risks: readonly RiskId[];
      /** Risks the call touched and the mission *did* accept (informational). */
      readonly covered_risks: readonly RiskId[];
      /** The exact slice(s) the plugin emitted for this call. */
      readonly executed_slices: readonly Slice[];
      /** Actionable hint for the caller (ask the creator to re-issue, restrict the operation). */
      readonly hint: string;
    };
