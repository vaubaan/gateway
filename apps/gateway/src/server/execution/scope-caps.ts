/**
 * Scope caps and the door (ADR scope-caps-amplification-axis).
 *
 * The v5.0 door has no cap stage (the plugin contract has no cap hook), and
 * a catalog's `caps` block is applied nowhere. The one catalog limit the
 * gateway does enforce is the ceiling on a mission's rate limit, checked when
 * the mission is issued (`missions/preview.ts`, `budgetProblem`) and then
 * enforced call by call through the mission's own rate limit.
 *
 * So that a catalog never states a limit the gateway does not apply, the
 * shipped catalogs may only declare the keys listed here; the structural test
 * `tests/unit/structural/catalog-caps-enforced.test.ts` fails otherwise.
 * Enforcing a new key means adding it here in the same change that adds the
 * enforcement and its test.
 */
import type { InfraLimits, RiskEntry, ScopeCaps } from '@vaubaan/shared';

/** `infra_limits` keys the gateway enforces. */
export const ENFORCED_INFRA_LIMIT_KEYS: readonly (keyof InfraLimits)[] = ['calls_per_minute_max'];

/** `caps` keys the gateway enforces: none in v5.0. */
export const ENFORCED_CAP_KEYS: readonly (keyof ScopeCaps)[] = [];

/** The limits an entry declares that nothing enforces, as `block.key` strings. */
export function unenforcedLimitsOf(entry: Pick<RiskEntry, 'caps' | 'infra_limits'>): string[] {
  return [
    ...unenforcedKeys('caps', entry.caps, ENFORCED_CAP_KEYS),
    ...unenforcedKeys('infra_limits', entry.infra_limits, ENFORCED_INFRA_LIMIT_KEYS),
  ];
}

function unenforcedKeys(
  block: string,
  declared: object | undefined,
  enforced: readonly string[],
): string[] {
  if (!declared) return [];
  return Object.keys(declared)
    .filter((key) => !enforced.includes(key))
    .map((key) => `${block}.${key}`);
}
