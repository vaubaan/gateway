/**
 * Capability grammar — the contract that crosses the runner ↔ gateway boundary.
 *
 * A capability is a 5-tuple `(provider, plane, level, action, env?)`.
 *
 * Spec : docs/spec/gateway-capability-model.draft.md
 *
 *  - provider : the vendor (routing + namespace).
 *  - plane    : a *pile concentrique* declared by the provider (`repo` for github,
 *               `runtime` for vercel, `db`/`storage`/`auth` for supabase, …).
 *               A provider may expose several planes (spec §2.1). The rank
 *               invariant (outer governs inner) only holds *within* a plane.
 *  - level    : the slug of a peel inside the plane (`code`, `rows`, `rls`, …).
 *               Provider-local — no universal archetype taxonomy (decision #4).
 *  - action   : `read` or `write`. Only two verbs (decision #3).
 *  - env      : an instance/variant slug (`prod`, `staging`, `feature-x`, …),
 *               dynamic (created on the fly like a git branch). Present ⟺ the
 *               targeted *data* is overlaid on this env (per-data, not per-level —
 *               decision #5).
 *
 * Notation (wire + audit) : `provider:plane/level:action@env`.
 */

export type Action = 'read' | 'write';

export const ACTIONS = ['read', 'write'] as const satisfies readonly Action[];

/** A dynamic env slug (free-form ; the gateway never enumerates them). */
export type Env = string;

export interface Capability {
  /** Vendor — used for routing and as the plane namespace. */
  provider: string;
  /** The pile (= one concentric stack of levels). */
  plane: string;
  /** The level slug inside that pile. */
  level: string;
  /** R/W. */
  action: Action;
  /** Present ⟺ the targeted data is calqué sur cet env. */
  env?: Env;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notation: `provider:plane/level:action@env`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Slug shape used for provider/plane/level/env tokens. Lowercase, alnum + `-`,
 * with an optional `/` in env to support branch-like slugs (`feature/x`). The
 * slug shape for provider/plane/level is strict ; env is slightly looser to
 * accept `main`, `feature/x`, `pr-42`, `@all` (the fan-out reserved keyword is
 * handled by callers, the regex itself just accepts the chars).
 */
const SLUG = '[a-z][a-z0-9-]*';
const ENV_SLUG = '[a-z0-9](?:[a-z0-9/_-]*[a-z0-9])?';
const NOTATION_RE = new RegExp(`^(${SLUG}):(${SLUG})/(${SLUG}):(read|write)(?:@(${ENV_SLUG}))?$`);

/** Canonical, always-full-form string. Stable key for sets / storage / audit. */
export function capabilityKey(c: Capability): string {
  return `${c.provider}:${c.plane}/${c.level}:${c.action}${c.env ? `@${c.env}` : ''}`;
}

/** Same as `capabilityKey` — kept for naming clarity at call sites. */
export const formatCapability = capabilityKey;

/**
 * Parse the notation `provider:plane/level:action@env` into a Capability.
 * Throws on malformed input. Validation of *whether* a given (provider, plane,
 * level) is emittable by a real plugin is done elsewhere (cf. ProviderModel's
 * `capabilities()` surface, spec §6) — this function is purely syntactic.
 */
export function parseCapability(s: string): Capability {
  const m = NOTATION_RE.exec(s.trim());
  if (!m) throw new Error(`invalid capability notation: '${s}'`);
  const [, provider, plane, level, action, env] = m;
  return {
    provider: provider!,
    plane: plane!,
    level: level!,
    action: action as Action,
    ...(env ? { env } : {}),
  };
}

/** Minimal structural check : action ∈ {read,write} + non-empty slugs. */
export function isValidCapability(c: Capability): boolean {
  if (!ACTIONS.includes(c.action)) return false;
  if (!c.provider || !c.plane || !c.level) return false;
  if (c.env !== undefined && c.env === '') return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage : the defensive set-membership check used at the hot path.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does a granted capability authorize a required one ? Exact 5-tuple match. No
 * implicit ladder, no env wildcard — that is the env defensive filter (spec
 * §7) : a `@prod` requirement needs a `@prod` grant ; an env-less requirement
 * needs an env-less grant. The two are distinct capabilities.
 */
export function covers(granted: Capability, required: Capability): boolean {
  return (
    granted.provider === required.provider &&
    granted.plane === required.plane &&
    granted.level === required.level &&
    granted.action === required.action &&
    granted.env === required.env
  );
}

/** Is the required capability satisfied by any capability in the granted set ? */
export function isGranted(grantedSet: readonly Capability[], required: Capability): boolean {
  return grantedSet.some((g) => covers(g, required));
}
