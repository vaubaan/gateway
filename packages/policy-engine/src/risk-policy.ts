/**
 * Risk catalog validation + acceptance-time env restriction.
 *
 * Spec : docs/spec/gateway-risk-model.md §6, §9.
 * ADR  : docs/decisions/unified-gates-drop-confirm.md.
 *
 * Post drop-confirm, the policy layer collapses to a single structural
 * guardrail : `acceptable_in_envs` on a catalog entry restricts which
 * binding envs can ever accept the risk. There is no project-level override
 * and no 3-gate resolution — a risk is either in `accepted_risks` (allow)
 * or it isn't (deny at runtime).
 */

import type { RiskCatalog, RiskEntry } from '@vaubaan/shared';

import { indexCatalog, type IndexedRiskCatalog } from './risk-evaluator.ts';

/**
 * Acceptance-time guard — refuse to accept a risk at mint time if the
 * catalog declares `acceptable_in_envs` and the requested binding env is
 * not in that list.
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

// ─────────────────────────────────────────────────────────────────────────────
// Catalog boot helper
// ─────────────────────────────────────────────────────────────────────────────

const RISK_ID_REGEX =
  /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$/;

/** One-call helper combining `indexCatalog` + sanity checks (ids unique,
 *  RiskId regex, fallback risk present). Used at boot. */
export function prepareCatalog(catalog: RiskCatalog): IndexedRiskCatalog {
  const indexed = indexCatalog(catalog);
  const ids = new Set<string>();
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
