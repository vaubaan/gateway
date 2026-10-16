/**
 * Structural test (ADR scope-caps-not-enforced-in-v5-0): a shipped catalog
 * never declares a limit the gateway does not enforce.
 *
 * The v5.0 door has no cap stage, so a `caps` block, or an `infra_limits` key
 * other than the rate ceiling checked at issuance, would be a control an
 * operator reads in the catalog and does not have. Enforcing a new key means
 * adding it to `ENFORCED_*_KEYS` in the same change as the enforcement.
 */
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';
import {
  ENFORCED_CAP_KEYS,
  ENFORCED_INFRA_LIMIT_KEYS,
  unenforcedLimitsOf,
} from '../../../src/server/execution/scope-caps';
import { budgetProblem } from '../../../src/server/missions/preview';

describe('shipped catalogs declare only the limits the door enforces', () => {
  it.each(SHIPPED_PLUGINS.map((plugin) => [plugin.id, plugin] as const))(
    '%s declares no unenforced cap',
    (_id, plugin) => {
      const offenders = plugin.catalog.risks.flatMap((entry) =>
        unenforcedLimitsOf(entry).map((limit) => `${entry.id}: ${limit}`),
      );
      expect(offenders).toEqual([]);
    },
  );

  it('flags a caps block and an unenforced infra limit, and passes the rate ceiling', () => {
    expect(unenforcedLimitsOf({ infra_limits: { calls_per_minute_max: 30 } })).toEqual([]);
    expect(
      unenforcedLimitsOf({
        caps: { items_per_call_max: 1, calls_per_minute_max: 3 },
        infra_limits: { calls_per_minute_max: 30, bytes_per_call_max: 1024 },
      }),
    ).toEqual([
      'caps.items_per_call_max',
      'caps.calls_per_minute_max',
      'infra_limits.bytes_per_call_max',
    ]);
  });

  it('the enforced list is exactly what the code enforces today', () => {
    expect(ENFORCED_CAP_KEYS).toEqual([]);
    expect(ENFORCED_INFRA_LIMIT_KEYS).toEqual(['calls_per_minute_max']);
    // …and that one key is enforced: a mission cannot be issued above the ceiling.
    const budget = {
      quota: 10,
      rate_limit: { max: 31, window_seconds: 60 },
      gate: 'auto',
    } as const;
    expect(budgetProblem(budget, { rate_ceiling_per_minute: 30 })).toMatch(/catalog ceiling of 30/);
    expect(
      budgetProblem(
        { ...budget, rate_limit: { max: 30, window_seconds: 60 } },
        { rate_ceiling_per_minute: 30 },
      ),
    ).toBeNull();
  });
});
