/**
 * Risk-based authorization types — v4 (post drop-confirm).
 *
 * Spec : docs/spec/gateway-risk-model.md.
 * ADR  : docs/decisions/unified-gates-drop-confirm.md.
 *
 * In the post-drop-confirm model the token does not carry a list of
 * capabilities ; it carries a list of *accepted risks* (`RiskId[]`)
 * qualified by binding. The plugin's `classify(tool, args)` returns one
 * or more `Slice` values (the slice touched at the call). The provider's
 * risk catalog (statically loaded YAML) maps slice patterns to
 * `RiskEntry` entries — each carrying a 6D `RiskVector` plus optional
 * structural restrictions (`acceptable_in_envs`). The runtime intersects
 * the executed slice with the catalog, derives the touched `RiskId[]`,
 * and authorizes iff that set is a subset of the token's
 * `accepted_risks`. There is **no** intermediate gate — a risk is either
 * accepted (in the list) or not.
 *
 * This module is the **type-only** contract. Logic lives in
 * `@vaubaan/policy-engine` (`slice-dsl.ts`, `slice-matcher.ts`,
 * `risk-evaluator.ts`, `risk-policy.ts`, `risk-runtime.ts`).
 */

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
 * The first segment is always the provider name (`github`, `vercel`, ...).
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
 *   ident    ::= [a-zA-Z0-9_/-]+   (allows '/' for refs like 'owner/repo')
 *   action   ::= 'R' | 'W'
 *
 * The asterisk in an `ident` segment (e.g. `[NEXT_PUBLIC_*]`) acts as a
 * glob over `[a-zA-Z0-9_/-]+`. The bare `[*]` matches any single segment ;
 * `[**]` matches zero or more segments. No regex.
 */
export interface Slice {
  /** Provider name (first path segment). Examples : 'github', 'vercel'. */
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
// Risk vector — 6D, attached to catalog entries (not to tokens)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 6 orthogonal risk axes synthesized from OWASP LLM06, NIST AI RMF
 * Agentic Profile, MITRE ATLAS v5.1, Five Eyes 2026-05, Anthropic RSP v3.
 *
 * Used to :
 *  - explain a risk in the UI / audit / docs (`reason` field is the
 *    natural-language version of the vector).
 *  - inform a human operator's decision when they consider checking a
 *    risk in the mint UI.
 *  - drive a visual ordering by severity in the mint UI (the only
 *    derived signal — no functional gate is computed from this).
 */
export interface RiskVector {
  readonly reversibility: 'reversible' | 'costly' | 'irreversible';
  readonly blast: 'single' | 'env' | 'account' | 'bulk';
  readonly data: 'metadata' | 'data' | 'secret' | 'pii';
  readonly cost: 'free' | 'moderate' | 'unbounded';
  readonly visibility: 'internal' | 'team' | 'public';
  readonly persistence: 'stateless' | 'session' | 'posture';
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk identifier and catalog entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable, version-controlled identifier for a risk.
 *
 * Format (cf. ADR `pivot-to-risk-based-model` §D2) :
 *   - Env-scoped     : `<provider>[<env>].<name>`
 *     ex: `supabase[staging].bulk-row-write`, `vercel[prod].env-var-write`
 *   - Non-env-scoped : `<provider>.<name>`
 *     ex: `github.mint-install-token`, `vercel.deploy-preview` (fan-out)
 *
 * Slug regex (validated at catalog load) :
 *   `^[a-z][a-z0-9]*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$`
 */
export type RiskId = string;

/**
 * One entry in a provider's risk catalog (statically declared in
 * `packages/providers/<vendor>/src/risk-catalog.yaml`).
 *
 * Each entry represents a named business intent ("write env vars on prod",
 * "merge to a protected branch", ...). The `matches` pattern is a slice
 * pattern (same grammar as Slice but allowed to contain `*`/`**` more
 * liberally). When a runtime slice is `intersect`-compatible with the
 * pattern, the entry is added to `risks_touched`.
 *
 * `acceptable_in_envs` (optional) is a *catalog-level* restriction (cf.
 * ADR D5 of pivot-to-risk-based-model) : a risk declared
 * `acceptable_in_envs: ['staging']` cannot be accepted for a binding with
 * `env: 'prod'`. This is the **only** structural guardrail post
 * drop-confirm — it cannot be overridden by the operator at mint.
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
   *  audit explainability only — no gate is derived from it. */
  readonly vector: RiskVector;
  /** When present, restricts which env scopes can ever accept this risk.
   *  E.g. ['preview', 'staging'] = never acceptable on env 'prod'. Enforced
   *  applicatively at mint (the env comes from the binding). */
  readonly acceptable_in_envs?: readonly string[];
  /** When true, the entry is kept for backward compatibility but should not
   *  be offered in new mints. UI displays "deprecated" badge. */
  readonly deprecated?: boolean;
  /** When `deprecated`, the replacement risk id (informational). */
  readonly replaced_by?: RiskId;
}

/** A provider's full risk catalog. */
export interface RiskCatalog {
  readonly provider: string;
  readonly risks: readonly RiskEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Token-level acceptance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The token-side authorization shape.
 *
 *  - `accepted_risks` : the set of `RiskId` the token-issuer accepted as
 *    consequence of letting the agent operate. The runtime authorizes a
 *    call iff `risks_touched ⊆ accepted_risks`.
 *  - `denied_risks`  : explicit opt-out, kept for forensic traceability
 *    (cf. drop-confirm ADR §D5 "Alternatives rejected → A3"). Runtime
 *    ignores this field ; the UI / audit can distinguish "non coché par
 *    oubli" from "non coché par décision".
 *
 * Note : `RiskId` already encodes the binding env (cf. ADR D2). The
 * bindings array (provider × resource × env) lives outside this type, on
 * the token row.
 */
export interface RiskAcceptance {
  readonly accepted_risks: readonly RiskId[];
  readonly denied_risks: readonly RiskId[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-call evaluation result
// ─────────────────────────────────────────────────────────────────────────────

/** Output of the runtime decision at `tools/call`. */
export type RiskDecision =
  | { readonly outcome: 'allowed'; readonly risks_touched: readonly RiskId[] }
  | {
      readonly outcome: 'denied';
      /** Risks the call touched but the token did not accept. */
      readonly missing_risks: readonly RiskId[];
      /** Risks the call touched and the token *did* accept (informational). */
      readonly covered_risks: readonly RiskId[];
      /** The exact slice(s) the plugin emitted for this call. */
      readonly executed_slices: readonly Slice[];
      /** Actionable hint for the caller (re-mint, escalate, ...). */
      readonly hint: string;
    };
