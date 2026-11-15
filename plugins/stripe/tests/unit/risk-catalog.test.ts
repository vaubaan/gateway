/**
 * Catalog invariants the SDK loader does not check for us : the cardinal
 * money-out entries keep their rate ceiling and declare no unenforced cap, the irreversible set is exact, every
 * named risk is env-scoped on the Stripe mode, and a handful of slices
 * resolve to the risk a reviewer expects. Structure, patterns, macro-actions and
 * fallback are validated by `loadCatalogFile` at import and by the kit in
 * `plugin.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { risksTouchedBy } from '@vaubaan/plugin-sdk/testing';

import { parseSlice } from '@vaubaan/plugin-sdk';

import { stripeCatalog } from '../../src/index.ts';

const { catalog, indexed } = stripeCatalog;

describe('stripe risk-catalog — shape', () => {
  test('16 named risks + 1 fallback, version 8', () => {
    expect(catalog.service).toBe('stripe');
    expect(catalog.risks).toHaveLength(17);
    expect(catalog.catalog_version).toBe(9);
    expect(catalog.risks.filter((r) => r.id.startsWith('stripe.uncategorized'))).toHaveLength(1);
  });

  test('every risk, fallback included, is env-scoped on the Stripe mode (test | live)', () => {
    for (const risk of catalog.risks) {
      expect(risk.acceptable_in_envs, risk.id).toEqual(['test', 'live']);
    }
  });

  test('no macro-action carries the fallback (it counts only when no dedicated entry matched)', () => {
    for (const action of catalog.macro_actions ?? []) {
      const fallback = action.entries.find((e) => e.risk_id.endsWith('.uncategorized-write'));
      expect(fallback, action.id).toBeUndefined();
    }
  });

  test('the money-out risks carry the rate ceiling, and no cap the door does not enforce', () => {
    for (const id of ['stripe.refund-create', 'stripe.payout-create']) {
      const entry = catalog.risks.find((r) => r.id === id);
      expect(entry, id).toBeDefined();
      expect(entry!.vector.cost).toBe('unbounded');
      expect(entry!.vector.reversibility).toBe('irreversible');
      // ADR scope-caps-amplification-axis : only the ceiling on a mission's rate limit.
      expect(entry!.infra_limits).toEqual({ calls_per_minute_max: 30 });
      expect(entry!.caps).toBeUndefined();
    }
  });

  test('the irreversible set is exact', () => {
    const ids = catalog.risks
      .filter((r) => r.vector.reversibility === 'irreversible')
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual([
      'stripe.customer-delete',
      'stripe.invoice-void',
      'stripe.payout-create',
      'stripe.refund-create',
      'stripe.subscription-cancel',
    ]);
  });
});

describe('stripe risk-catalog — slices resolve to the expected risk', () => {
  const touched = (raw: string) => risksTouchedBy(parseSlice(raw), indexed);
  const root = 'stripe.account[acct_x/live].mode[live]';

  // The full set, not `toContain` : a trailing `[**]` matches zero
  // identifiers and deeper paths alike, so a creation, a verb leaf or an
  // overlay also touches the entry of the entity it hangs from.
  test.each([
    [`${root}.product[prod_x].R`, ['stripe.read-catalog']],
    [`${root}.customer[cus_x].pii.R`, ['stripe.read-billing-history', 'stripe.read-customer-pii']],
    [`${root}.balance.R`, ['stripe.read-balance']],
    [`${root}.payment-intent[pi_x].charge[ch_x].refund.W`, ['stripe.refund-create']],
    [`${root}.payout.W`, ['stripe.payout-create']],
    [`${root}.customer[cus_x].delete.W`, ['stripe.customer-delete']],
    [
      `${root}.customer[cus_x].subscription.W`,
      ['stripe.subscription-create', 'stripe.subscription-update'],
    ],
    [`${root}.customer[cus_x].subscription[sub_x].W`, ['stripe.subscription-update']],
    [
      `${root}.customer[cus_x].subscription[sub_x].cancel.W`,
      ['stripe.subscription-update', 'stripe.subscription-cancel'],
    ],
    [`${root}.customer[cus_x].invoice.W`, ['stripe.invoice-create-draft']],
    [`${root}.customer[cus_x].invoice[*].finalize.W`, ['stripe.invoice-finalize']],
    [
      `${root}.webhook-endpoint[we_x].secret.W`,
      ['stripe.webhook-endpoint-write', 'stripe.mint-webhook-secret'],
    ],
  ])('%s → %j', (raw, risks) => {
    expect(touched(raw)).toEqual(risks);
  });

  test('finalize and void are distinct ; delete is not an update', () => {
    const finalize = touched(`${root}.customer[cus_x].invoice[in_x].finalize.W`);
    const voided = touched(`${root}.customer[cus_x].invoice[in_x].void.W`);
    expect(finalize).toContain('stripe.invoice-finalize');
    expect(finalize).not.toContain('stripe.invoice-void');
    expect(voided).toContain('stripe.invoice-void');
    expect(voided).not.toContain('stripe.invoice-finalize');
    const del = touched(`${root}.customer[cus_x].delete.W`);
    expect(del).not.toContain('stripe.subscription-update');
    expect(del).not.toContain('stripe.invoice-create-draft');
  });

  test('a novel write falls into the fallback only', () => {
    expect(touched(`${root}.connect-account[acct_y].W`)).toEqual(['stripe.uncategorized-write']);
  });

  test('the cash side effect of create_subscription is covered by subscription-create, not the fallback', () => {
    expect(touched(`${root}.payment-intent.W`)).toEqual(['stripe.subscription-create']);
  });
});
