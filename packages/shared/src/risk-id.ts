/**
 * RiskId — structured parser and formatter.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 ("RiskId"), docs/spec/gateway-risk-model.md §4.
 *
 * Two forms exist :
 *   - account-scoped : `<provider>.<name>`          e.g. `github.merge-protected`
 *   - env-scoped     : `<provider>[<env>].<name>`   e.g. `supabase[prod].bulk-row-write`
 *
 * The catalog YAML stores the account-scoped form ; the env qualifier is
 * added when a risk is accepted for a resource carrying an environment label
 * (`@vaubaan/policy-engine` `qualifyRiskId`). This module owns the grammar so
 * no other package does string surgery on ids.
 */

import type { RiskId } from './risk.ts';

/** Provider id : lowercase slug, `-` separated, no `_` (tool prefixes map `-` → `_`). */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$/;

/** Environment label : lowercase slug (`prod`, `staging`, `preview-eu`). */
export const ENV_LABEL_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Full RiskId grammar. Groups : 1 = provider, 2 = env (optional), 3 = name
 * with its leading dot. The name may itself contain dots
 * (`github.search.code` is a valid id with name `search.code`).
 */
export const RISK_ID_PATTERN =
  /^([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)(?:\[([a-z][a-z0-9-]*)\])?((?:\.[a-z][a-z0-9-]+)+)$/;

export interface ParsedRiskId {
  readonly provider: string;
  /** `null` for the account-scoped form. */
  readonly env: string | null;
  /** Everything after the first dot, without the dot. */
  readonly name: string;
}

/** Parse a RiskId ; `null` when the string is not a well-formed id. */
export function parseRiskId(raw: string): ParsedRiskId | null {
  const m = RISK_ID_PATTERN.exec(raw);
  if (!m) return null;
  return { provider: m[1]!, env: m[2] ?? null, name: m[3]!.slice(1) };
}

/** Inverse of `parseRiskId`. `env` null or empty yields the account-scoped form. */
export function formatRiskId(parts: {
  readonly provider: string;
  readonly env?: string | null;
  readonly name: string;
}): RiskId {
  const env = parts.env ?? null;
  return env === null || env.length === 0
    ? `${parts.provider}.${parts.name}`
    : `${parts.provider}[${env}].${parts.name}`;
}

/** True iff `raw` matches the RiskId grammar (either form). */
export function isRiskId(raw: string): boolean {
  return RISK_ID_PATTERN.test(raw);
}

/** True iff `raw` is a well-formed provider id. */
export function isProviderId(raw: string): boolean {
  return PROVIDER_ID_PATTERN.test(raw);
}

/**
 * Account-scoped twin of an id (the catalog lookup key) : strips the env
 * qualifier when present, returns the input unchanged otherwise. Throws on a
 * malformed id — callers hold ids that already passed validation.
 */
export function baseRiskId(id: RiskId): RiskId {
  const parsed = parseRiskId(id);
  if (!parsed) throw new Error(`Malformed RiskId '${id}'`);
  return formatRiskId({ provider: parsed.provider, name: parsed.name });
}

/**
 * Characters that would turn an id into a pattern. No persisted restriction,
 * `accepted_risks`, preset entry or share may contain one (spec §10).
 */
export const WILDCARD_CHARS = /[*?]/;

/** True iff the string is a plain, enumerable id (no glob, no sentinel). */
export function isExplicitRiskId(raw: string): boolean {
  return isRiskId(raw) && !WILDCARD_CHARS.test(raw);
}
