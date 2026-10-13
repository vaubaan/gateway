/**
 * Catalog invariants the SDK loader does not check for us : the cardinal
 * money-out entries keep their caps, the irreversible set is exact, every
 * named risk is env-scoped on the Stripe mode, and a handful of slices
 * resolve to the risk a reviewer expects. Structure, patterns, presets and
 * fallback are validated by `loadCatalogFile` at import and by the kit in
 * `plugin.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { parseSlice } from '@vaubaan/plugin-sdk';
import { risksTouchedBy } from '@vaubaan/policy-engine';

import { stripeCatalog, stripePlugin, stripeRiskCatalog } from '../../src/index.ts';

const { catalog, indexed } = stripeCatalog;

describe('stripe risk-catalog — shape', () => {
  test('16 named risks + 1 fallback, version 3', () => {
    expect(catalog.provider).toBe('stripe');
    expect(catalog.risks).toHaveLength(17);
    expect(catalog.catalog_version).toBe(3);
    expect(catalog.risks.filter((r) => r.id.startsWith('stripe.uncategorized'))).toHaveLength(1);
  });

  test('every risk, fallback included, is env-scoped on the Stripe mode (test | live)', () => {
    for (const risk of catalog.risks) {
      expect(risk.acceptable_in_envs, risk.id).toEqual(['test', 'live']);
    }
  });

  test('no preset carries the fallback (it counts only when no dedicated entry matched)', () => {
    for (const preset of catalog.presets) {
      const fallback = preset.entries.find((e) => e.risk_id.endsWith('.uncategorized-write'));
      expect(fallback, preset.id).toBeUndefined();
    }
  });

  test('the money-out risks carry caps and infra limits', () => {
    for (const id of ['stripe.refund-create', 'stripe.payout-create']) {
      const entry = catalog.risks.find((r) => r.id === id);
      expect(entry, id).toBeDefined();
      expect(entry!.vector.cost).toBe('unbounded');
      expect(entry!.vector.reversibility).toBe('irreversible');
      expect(entry!.caps?.items_per_call_max).toBe(1);
      expect(entry!.infra_limits?.calls_per_minute_max).toBe(30);
    }
    const refund = catalog.risks.find((r) => r.id === 'stripe.refund-create')!;
    expect(refund.caps).toEqual({
      items_per_call_max: 1,
      calls_per_minute_max: 3,
      calls_per_session_max: 20,
    });
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

  test('the legacy export is the loaded catalog itself', () => {
    expect(stripeRiskCatalog).toBe(stripePlugin.catalog);
  });
});

describe('stripe risk-catalog — slices resolve to the expected risk', () => {
  const touched = (raw: string) => risksTouchedBy(parseSlice(raw), indexed);
  const root = 'stripe.account[acct_x/live].mode[live]';

  test.each([
    [`${root}.product[prod_x].R`, 'stripe.read-catalog'],
    [`${root}.customer[cus_x].pii.R`, 'stripe.read-customer-pii'],
    [`${root}.balance.R`, 'stripe.read-balance'],
    [`${root}.payment-intent[pi_x].charge[ch_x].refund.W`, 'stripe.refund-create'],
    [`${root}.payout.W`, 'stripe.payout-create'],
    [`${root}.customer[cus_x].delete.W`, 'stripe.customer-delete'],
    [`${root}.customer[cus_x].subscription[sub_x].cancel.W`, 'stripe.subscription-cancel'],
    [`${root}.webhook-endpoint[we_x].secret.W`, 'stripe.mint-webhook-secret'],
  ])('%s → %s', (raw, risk) => {
    expect(touched(raw)).toContain(risk);
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
