/**
 * Project risk policy — resolve the effective gate for a `RiskId` in the
 * context of a project + binding.
 *
 * Spec : docs/spec/gateway-risk-model.md §6.
 *
 * The catalog declares a `default_gate` per risk. The project can override
 * via `project_risk_policies (risk_id, env_scope, gate)`. Resolution :
 *
 *   1. Look for an override with `env_scope = <binding.env>` — wins if found.
 *   2. Look for an override with `env_scope = null` (applies to all bindings).
 *   3. Fall back to the catalog's `default_gate`.
 *
 * The acceptance-time guards (ADR §D1, §D5) are enforced separately :
 *  - `D1` : a `deny → allow` override on a risk with vector
 *           `persistence: posture` OR (`data: secret` AND action: W) is
 *           refused by SQL CHECK + middleware (only `admin` role).
 *  - `D5` : `acceptable_in_envs` on a catalog entry restricts which
 *           bindings can ever accept the risk, regardless of the override.
 */

import type { RiskCatalog, RiskEntry, RiskGate, RiskId, RiskPolicyOverride } from '@vaubaan/shared';

import { findRiskEntry, indexCatalog, type IndexedRiskCatalog } from './risk-evaluator.ts';

export interface EffectiveGateDecision {
  readonly risk_id: RiskId;
  readonly gate: RiskGate;
  /** Where the gate value came from — for UI explainability. */
  readonly origin: 'catalog-default' | 'project-policy-env-scoped' | 'project-policy-global';
  /** The catalog entry (for `reason`, `vector`, label display). May be
   *  undefined iff the risk_id is unknown (typically a stale token after
   *  a deprecation removal — runtime should treat as `deny`). */
  readonly entry?: RiskEntry;
}

/**
 * Resolve the effective gate of one `RiskId` for a binding env.
 *
 * @param riskId    — the risk being asked about (already qualified by env
 *                    if env-scoped, e.g. `supabase[staging].bulk-row-write`).
 * @param env       — the binding env (e.g. `staging`, `prod`, `feature-x`).
 *                    `null` when the binding has no env (account-scope).
 * @param catalog   — the indexed catalog of the provider this risk belongs to.
 * @param overrides — the project's `project_risk_policies` rows for this
 *                    project (caller is responsible for filtering by
 *                    `project_id` — we don't carry it through here).
 */
export function resolveEffectiveGate(
  riskId: RiskId,
  env: string | null,
  catalog: IndexedRiskCatalog,
  overrides: readonly RiskPolicyOverride[],
): EffectiveGateDecision {
  const entry = findRiskEntry(catalog, riskId);

  // Look for env-scoped override first (most specific).
  if (env !== null) {
    const envScoped = overrides.find((o) => o.risk_id === riskId && o.env_scope === env);
    if (envScoped) {
      return {
        risk_id: riskId,
        gate: envScoped.gate,
        origin: 'project-policy-env-scoped',
        entry,
      };
    }
  }

  // Then global (project-wide) override.
  const global = overrides.find((o) => o.risk_id === riskId && o.env_scope === null);
  if (global) {
    return {
      risk_id: riskId,
      gate: global.gate,
      origin: 'project-policy-global',
      entry,
    };
  }

  // Catalog default. If the risk is unknown (token after a deprecated-remove,
  // future-proofing), treat as `deny` — the runtime must not let an unknown
  // risk silently pass.
  return {
    risk_id: riskId,
    gate: entry?.default_gate ?? 'deny',
    origin: 'catalog-default',
    entry,
  };
}

/** Resolve effective gates for a batch of `RiskId`s. */
export function resolveEffectiveGates(
  riskIds: readonly RiskId[],
  env: string | null,
  catalog: IndexedRiskCatalog,
  overrides: readonly RiskPolicyOverride[],
): EffectiveGateDecision[] {
  return riskIds.map((id) => resolveEffectiveGate(id, env, catalog, overrides));
}

/**
 * D5 check — refuse to accept a risk at mint time if the catalog declares
 * `acceptable_in_envs` and the requested binding env is not in that list.
 *
 * Returns `null` if OK to accept, or a denial reason string.
 */
export function checkAcceptableInEnv(entry: RiskEntry, env: string | null): string | null {
  if (!entry.acceptable_in_envs) return null;
  if (env === null) {
    return (
      `risk '${entry.id}' restricts acceptance to envs ` +
      `[${entry.acceptable_in_envs.join(', ')}] but the binding has no env (account-scope)`
    );
  }
  if (!entry.acceptable_in_envs.includes(env)) {
    return (
      `risk '${entry.id}' is not acceptable in env '${env}' ` +
      `(catalog restricts to [${entry.acceptable_in_envs.join(', ')}])`
    );
  }
  return null;
}

/**
 * D1 helper — does a catalog entry require admin role to be overridden
 * `deny → allow` ? The runtime / API caller is then responsible for
 * checking the user's role (this module is pure).
 */
export function requiresAdminToOverrideDenyAllow(entry: RiskEntry): boolean {
  // posture-shifting → admin-only
  if (entry.vector.persistence === 'posture') return true;
  // secret / pii writes → admin-only. We infer "write" from ANY of the
  // entry's patterns ending in '.W' (entry.matches may be string or
  // string[] since the v4 catalog allows disjoint patterns).
  const patterns: readonly string[] =
    typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
  const anyWrite = patterns.some((p) => p.endsWith('.W'));
  if (entry.vector.data === 'secret' && anyWrite) return true;
  if (entry.vector.data === 'pii' && anyWrite) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default-gate seeding from a 6D vector — used to populate the catalog
// programmatically and to lint that authors have not put a `default_gate`
// that contradicts the vector.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the recommended `default_gate` from a vector. Spec §4.2.
 *
 * Rule order :
 *   1. (`persistence: posture`) OR (W with `data: secret|pii`)  → `deny`
 *   2. (`reversibility: irreversible`) OR (`blast: account|bulk`) → `confirm`
 *   3. otherwise                                                  → `allow`
 *
 * The catalog author can deviate but a lint warns when YAML's
 * `default_gate` is strictly more permissive than this recommendation.
 */
export function seedDefaultGate(vector: RiskEntry['vector'], action: 'R' | 'W' = 'W'): RiskGate {
  if (vector.persistence === 'posture') return 'deny';
  if (action === 'W' && (vector.data === 'secret' || vector.data === 'pii')) return 'deny';
  if (vector.reversibility === 'irreversible') return 'confirm';
  if (vector.blast === 'account' || vector.blast === 'bulk') return 'confirm';
  if (vector.cost === 'unbounded') return 'confirm';
  return 'allow';
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience : load + index a raw catalog object
// ─────────────────────────────────────────────────────────────────────────────

/** One-call helper combining `indexCatalog` + sanity checks (fallback risk
 *  exists, ids unique, RiskId regex). Used at boot. */
export function prepareCatalog(catalog: RiskCatalog): IndexedRiskCatalog {
  const indexed = indexCatalog(catalog);
  const ids = new Set<RiskId>();
  for (const { entry } of indexed.entries) {
    if (ids.has(entry.id)) {
      throw new Error(`Duplicate risk id '${entry.id}' in catalog '${catalog.provider}'`);
    }
    ids.add(entry.id);
    if (!RISK_ID_REGEX.test(entry.id)) {
      throw new Error(
        `Risk id '${entry.id}' in catalog '${catalog.provider}' does not match expected format ` +
          `'<provider>[<env>].<name>' or '<provider>.<name>'`,
      );
    }
  }
  // A catalog SHOULD have a fallback risk. We don't enforce hard (some
  // providers may opt out and have an empty fallback risk surface), but
  // emit a console warning when missing — lint at CI.
  const hasFallback = indexed.entries.some((e) =>
    e.entry.id.startsWith(`${catalog.provider}.uncategorized`),
  );
  if (!hasFallback) {
    console.warn(
      `[risk-policy] catalog '${catalog.provider}' has no '<provider>.uncategorized-*' fallback ` +
        `risk — concrete slices not matching any catalog entry will silently produce empty ` +
        `risks_touched, which the runtime treats as 'deny' (safe-by-default). Add a fallback.`,
    );
  }
  return indexed;
}

const RISK_ID_REGEX = /^[a-z][a-z0-9]*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$/;

export { RISK_ID_REGEX };
