/**
 * Decision-path suite of the Stripe plugin : each case goes through the real
 * classifier, the real YAML catalog and the engine's `evaluateCall` with the
 * resolver the host builds (`envResolverFor(resources, plugin.envOf)`) — the
 * same composition as `evaluateCallForToken` in `@vaubaan/gateway-core`,
 * which a plugin does not import.
 *
 * Covers what the tool-by-tool suite cannot see : an argument that changes
 * the nature of a call must cost the stronger risk, customer PII must not be
 * reachable through `read-billing-history`, every risk is refused outside
 * the mode it was accepted for, and each mission composed from macro-actions
 * (risk model §4.6) allows what it describes on its mode and nothing on the other.
 */
import { describe, expect, test } from 'vitest';

import { parseSlice, type ProviderPlugin, type Resource, type RiskId } from '@vaubaan/plugin-sdk';
import {
  envResolverFor,
  evaluateCall,
  policyFromMacroActions,
  qualifyRiskId,
  resourceEnvResolver,
} from '@vaubaan/plugin-sdk/testing';

import { stripeCatalog, stripePlugin } from '../../src/index.ts';

/** Seen through the contract, as the host sees it (the optional hooks included). */
const plugin: ProviderPlugin = stripePlugin;

const TEST = 'acct_1/test';
const LIVE = 'acct_1/live';

const testRes: Resource = {
  provider: 'stripe',
  ref: TEST,
  env: 'test',
  displayName: 'Acme (test)',
  metadata: { account_id: 'acct_1', mode: 'test' },
};
const liveRes: Resource = {
  provider: 'stripe',
  ref: LIVE,
  env: 'live',
  displayName: 'Acme (live)',
  metadata: { account_id: 'acct_1', mode: 'live' },
};
const both: readonly Resource[] = [testRes, liveRes];

type Args = Readonly<Record<string, unknown>>;

type Verdict =
  | { readonly kind: 'allow'; readonly touched: readonly RiskId[] }
  | { readonly kind: 'deny'; readonly missing: readonly RiskId[]; readonly hint: string }
  | { readonly kind: 'classify-denied'; readonly reason: string };

/** The risk step of one call, composed as the gateway composes it. */
function decide(
  tool: string,
  args: Args,
  accepted: readonly RiskId[],
  resources: readonly Resource[] = both,
): Verdict {
  const classified = plugin.classify(tool, args, resources);
  if ('denied' in classified) return { kind: 'classify-denied', reason: classified.denied };
  const decision = evaluateCall({
    executed_slices: classified.slices,
    token_accepted_risks: new Set(accepted),
    catalog: stripeCatalog.indexed,
    envResolver: envResolverFor(resources, plugin.envOf?.bind(plugin)),
  });
  return decision.outcome === 'allowed'
    ? { kind: 'allow', touched: decision.risks_touched }
    : { kind: 'deny', missing: decision.missing_risks, hint: decision.hint };
}

const missingOf = (verdict: Verdict): readonly RiskId[] => {
  if (verdict.kind !== 'deny') throw new Error(`expected a deny, got ${JSON.stringify(verdict)}`);
  return verdict.missing;
};

type Crans = Parameters<typeof policyFromMacroActions>[1];

/**
 * The missions of this suite, as a creator composes them : macro-actions at a
 * trust cran, and the risks a creator unticks in the advanced view.
 */
const MISSIONS: Readonly<Record<string, { crans: Crans; untick?: readonly string[] }>> = {
  // Books at Prudent, customer PII unticked.
  'read-only': { crans: { books: 'prudent' }, untick: ['read-customer-pii'] },
  'test-mode-developer': {
    crans: {
      books: 'autonome',
      'set-up': 'autonome',
      bill: 'autonome',
      'money-out': 'autonome',
      cancel: 'autonome',
    },
  },
  'finance-operator': {
    crans: { books: 'confiant', bill: 'confiant', 'money-out': 'confiant', cancel: 'confiant' },
  },
};

/**
 * The accepted set a mission yields on a selection of resources : one line per
 * mode the selection carries (what issuance persists).
 */
function acceptedFrom(missionId: string, selected: readonly Resource[]): RiskId[] {
  const mission = MISSIONS[missionId];
  if (!mission) throw new Error(`no mission '${missionId}'`);
  const envs = selected.flatMap((r) => (r.env ? [r.env] : []));
  return policyFromMacroActions(stripePlugin, mission.crans, { envs })
    .map((e) => e.risk_id)
    .filter((id) => !(mission.untick ?? []).some((name) => id.endsWith(`].${name}`)));
}

/** One realistic call per tool ; `account` is added by the caller. */
const SAMPLES: Readonly<Record<string, Args>> = {
  stripe__list_products: {},
  stripe__list_prices: { product: 'prod_x' },
  stripe__list_customers: {},
  stripe__retrieve_customer: { id: 'cus_x' },
  stripe__list_subscriptions: { customer: 'cus_x' },
  stripe__list_invoices: {},
  stripe__list_charges: {},
  stripe__list_payment_intents: {},
  stripe__get_balance: {},
  stripe__list_events: {},
  stripe__create_product: { name: 'Pro' },
  stripe__update_product: { id: 'prod_x', name: 'Pro+' },
  stripe__create_price: { product: 'prod_x', unit_amount: 100, currency: 'eur' },
  stripe__update_price: { id: 'price_x', active: false },
  stripe__create_coupon: { percent_off: 10 },
  stripe__create_promotion_code: { coupon: 'co_x' },
  stripe__create_subscription: { customer: 'cus_x', items: [{ price: 'price_x' }] },
  stripe__update_subscription: { id: 'sub_x', metadata: { k: 'v' } },
  stripe__cancel_subscription: { id: 'sub_x' },
  stripe__pause_subscription: { id: 'sub_x', pause_collection: { behavior: 'void' } },
  stripe__create_invoice: { customer: 'cus_x' },
  stripe__finalize_invoice: { id: 'in_x' },
  stripe__void_invoice: { id: 'in_x' },
  stripe__create_refund: { charge: 'ch_x' },
  stripe__create_payout: { amount: 100, currency: 'eur' },
  stripe__delete_customer: { id: 'cus_x' },
  stripe__create_webhook_endpoint: { url: 'https://example.test/hook', enabled_events: ['*'] },
};
const TOOLS = Object.keys(SAMPLES);

const on = (ref: string, tool: string): Args => ({ ...SAMPLES[tool], account: ref });

test('the sample table covers every declared tool', () => {
  expect([...TOOLS].sort()).toEqual(plugin.tools.map((t) => t.name).sort());
});

describe('an argument that changes the nature of the call costs the stronger risk (M3)', () => {
  const update = ['stripe[live].subscription-update'];

  test.each([
    ['cancel_at_period_end: true', { cancel_at_period_end: true }],
    ['cancel_at_period_end as a string', { cancel_at_period_end: 'true' }],
    ['a cancel_at timestamp', { cancel_at: 1893456000 }],
    ['a cancel_at enum', { cancel_at: 'min_period_end' }],
  ])('update_subscription with %s needs subscription-cancel', (_label, extra) => {
    const args = { account: LIVE, id: 'sub_x', ...extra };
    expect(missingOf(decide('stripe__update_subscription', args, update))).toEqual([
      'stripe[live].subscription-cancel',
    ]);
    expect(
      decide('stripe__update_subscription', args, [...update, 'stripe[live].subscription-cancel'])
        .kind,
    ).toBe('allow');
  });

  test('pause_subscription declares no cancellation field : the call is refused outright', () => {
    const args = { account: LIVE, id: 'sub_x', pause_collection: {}, cancel_at_period_end: true };
    expect(decide('stripe__pause_subscription', args, update)).toEqual({
      kind: 'classify-denied',
      reason:
        "cancel_at_period_end: not an argument of 'stripe__pause_subscription' — nothing classifies it, so it is not sent.",
    });
  });

  test('a plain update, or one that clears a scheduled cancellation, stays an update', () => {
    for (const extra of [{}, { cancel_at_period_end: false }, { cancel_at: null }]) {
      const args = { account: LIVE, id: 'sub_x', ...extra };
      expect(decide('stripe__update_subscription', args, update)).toEqual({
        kind: 'allow',
        touched: update,
      });
    }
  });

  test('create_invoice with auto_advance needs invoice-finalize', () => {
    const draft = ['stripe[live].invoice-create-draft'];
    for (const auto_advance of [true, 'true', 1]) {
      const args = { account: LIVE, customer: 'cus_x', auto_advance };
      expect(missingOf(decide('stripe__create_invoice', args, draft))).toEqual([
        'stripe[live].invoice-finalize',
      ]);
    }
    for (const extra of [{}, { auto_advance: false }]) {
      const args = { account: LIVE, customer: 'cus_x', ...extra };
      expect(decide('stripe__create_invoice', args, draft).kind).toBe('allow');
    }
  });
});

describe('customer PII is not reachable with read-billing-history alone (M4)', () => {
  const history = ['stripe[live].read-billing-history', 'stripe[live].read-balance'];
  const pii = 'stripe[live].read-customer-pii';

  test.each([
    ['stripe__list_invoices', {}],
    ['stripe__list_invoices', { customer: 'cus_x' }],
    ['stripe__list_charges', {}],
    ['stripe__list_payment_intents', {}],
    ['stripe__list_events', {}],
    ['stripe__list_events', { type: 'customer.created' }],
    ['stripe__list_events', { type: 'invoice.*' }],
    ['stripe__list_events', { type: ['payout.paid'] }],
  ])('%s %j returns customer fields : needs read-customer-pii', (tool, extra) => {
    const args = { account: LIVE, ...extra };
    expect(missingOf(decide(tool, args, history))).toEqual([pii]);
    expect(decide(tool, args, [...history, pii]).kind).toBe('allow');
  });

  test('reads that carry no customer field stay under their own risk', () => {
    expect(decide('stripe__list_subscriptions', { account: LIVE }, history).kind).toBe('allow');
    for (const type of ['payout.paid', 'balance.available', 'product.*', 'price.created']) {
      expect(decide('stripe__list_events', { account: LIVE, type }, history).kind).toBe('allow');
    }
  });

  const everythingLive = stripeCatalog.catalog.risks.map((r) => qualifyRiskId(r.id, 'live', r));

  // A key that is not name-shaped (`expand[]`) is described, never quoted, by the SDK's denial.
  test.each([
    ['expand', 'expand'],
    ['expand[]', 'an argument with a malformed name'],
    ['expand[0]', 'an argument with a malformed name'],
  ])('%s is refused on every tool', (key, label) => {
    for (const tool of TOOLS) {
      const args = { ...on(LIVE, tool), [key]: ['data.customer'] };
      expect(decide(tool, args, everythingLive), tool).toEqual({
        kind: 'classify-denied',
        reason: `${label}: not an argument of '${tool}' — nothing classifies it, so it is not sent.`,
      });
    }
  });

  test('any argument the tool does not declare is refused, whatever the mission accepts', () => {
    for (const [tool, extra] of [
      ['stripe__create_invoice', { collection_method: 'charge_automatically' }],
      ['stripe__create_subscription', { cancel_at: 1893456000 }],
      ['stripe__list_invoices', { created: { gte: 0 } }],
      ['stripe__create_refund', { reverse_transfer: true }],
    ] as const) {
      const verdict = decide(tool, { ...on(LIVE, tool), ...extra }, everythingLive);
      expect(verdict.kind, tool).toBe('classify-denied');
    }
  });
});

describe('the mode of a call : resolved from the resource, refused when it cannot be', () => {
  const everything = stripeCatalog.catalog.risks.flatMap((r) =>
    (r.acceptable_in_envs ?? []).map((env) => qualifyRiskId(r.id, env, r)),
  );

  test('the qualifier is the mode of the targeted resource', () => {
    expect(decide('stripe__create_refund', on(TEST, 'stripe__create_refund'), everything)).toEqual({
      kind: 'allow',
      touched: ['stripe[test].refund-create'],
    });
    expect(decide('stripe__create_refund', on(LIVE, 'stripe__create_refund'), everything)).toEqual({
      kind: 'allow',
      touched: ['stripe[live].refund-create'],
    });
  });

  test('a resource with no resolvable mode is refused, whatever the mission accepts', () => {
    const noMode: Resource = { provider: 'stripe', ref: 'acct_1', displayName: 'Acme' };
    for (const resource of [
      noMode,
      { ...noMode, env: 'live' },
      { ...noMode, env: 'production' },
      { ...noMode, metadata: { mode: 'sandbox' } },
    ]) {
      for (const tool of ['stripe__get_balance', 'stripe__create_refund']) {
        expect(decide(tool, SAMPLES[tool]!, everything, [resource])).toEqual({
          kind: 'classify-denied',
          reason: "account: cannot determine the test/live mode of 'acct_1'",
        });
      }
    }
  });

  test('a label that contradicts the mode of the key is refused, never trusted', () => {
    for (const env of ['test', 'prod', undefined, null]) {
      const relabelled: Resource = { ...liveRes, env };
      expect(decide('stripe__create_refund', { charge: 'ch_x' }, everything, [relabelled])).toEqual(
        {
          kind: 'classify-denied',
          reason: `account: '${LIVE}' is a live-mode resource but its environment label is not 'live'`,
        },
      );
    }
  });

  test('the engine itself refuses a Stripe slice on a resource without environment', () => {
    // Defence in depth : even a slice the classifier no longer emits is refused,
    // because every Stripe risk is env-scoped on [test, live].
    const unlabelled: Resource = { provider: 'stripe', ref: 'acct_1', displayName: 'Acme' };
    const baseIds = stripeCatalog.catalog.risks.map((r) => r.id);
    for (const raw of [
      'stripe.account[acct_1].mode[*].balance.R',
      'stripe.account[acct_1].mode[*].payment-intent[*].charge[ch_x].refund.W',
    ]) {
      const decision = evaluateCall({
        executed_slices: [parseSlice(raw)],
        token_accepted_risks: new Set([...everything, ...baseIds]),
        catalog: stripeCatalog.indexed,
        envResolver: resourceEnvResolver([unlabelled]),
      });
      expect(decision.outcome, raw).toBe('denied');
    }
  });
});

describe('missions from macro-actions : what they describe on their mode, nothing on the other', () => {
  const READ_ONLY_ALLOWED = [
    'stripe__list_products',
    'stripe__list_prices',
    'stripe__list_subscriptions',
    'stripe__get_balance',
  ];

  test.each([
    [TEST, [testRes], LIVE],
    [LIVE, [liveRes], TEST],
  ])('read-only on %s : catalog, subscriptions, balance — no PII, no write', (ref, sel, other) => {
    const accepted = acceptedFrom('read-only', sel);
    for (const tool of TOOLS) {
      const expected = READ_ONLY_ALLOWED.includes(tool) ? 'allow' : 'deny';
      expect(decide(tool, on(ref, tool), accepted).kind, `${tool} on ${ref}`).toBe(expected);
      expect(decide(tool, on(other, tool), accepted).kind, `${tool} on ${other}`).toBe('deny');
    }
    // Events without customer payload are part of the cash position.
    const payouts = { account: ref, type: 'payout.*' };
    expect(decide('stripe__list_events', payouts, accepted).kind).toBe('allow');
    expect(decide('stripe__list_events', { ...payouts, account: other }, accepted).kind).toBe(
      'deny',
    );
  });

  test('test-mode-developer : every tool on test, none on live', () => {
    const accepted = acceptedFrom('test-mode-developer', [testRes]);
    for (const tool of TOOLS) {
      expect(decide(tool, on(TEST, tool), accepted).kind, `${tool} on test`).toBe('allow');
      const live = decide(tool, on(LIVE, tool), accepted);
      expect(live.kind, `${tool} on live`).toBe('deny');
      expect(missingOf(live).every((id) => id.startsWith('stripe[live].'))).toBe(true);
    }
    const cancel = { account: TEST, id: 'sub_x', cancel_at_period_end: true };
    expect(decide('stripe__update_subscription', cancel, accepted).kind).toBe('allow');
    const advance = { account: TEST, customer: 'cus_x', auto_advance: true };
    expect(decide('stripe__create_invoice', advance, accepted).kind).toBe('allow');
  });

  test('finance-operator : live billing operations, no catalog or webhook write, nothing on test', () => {
    const accepted = acceptedFrom('finance-operator', [liveRes]);
    const refusedOnLive = [
      'stripe__create_product',
      'stripe__update_product',
      'stripe__create_price',
      'stripe__update_price',
      'stripe__create_coupon',
      'stripe__create_promotion_code',
      'stripe__create_webhook_endpoint',
    ];
    for (const tool of TOOLS) {
      const expected = refusedOnLive.includes(tool) ? 'deny' : 'allow';
      expect(decide(tool, on(LIVE, tool), accepted).kind, `${tool} on live`).toBe(expected);
      expect(decide(tool, on(TEST, tool), accepted).kind, `${tool} on test`).toBe('deny');
    }
  });

  test('no mission lets a call through on the fallback or on a risk it does not list', () => {
    for (const id of Object.keys(MISSIONS)) {
      const accepted = acceptedFrom(id, both);
      for (const tool of TOOLS) {
        for (const ref of [TEST, LIVE]) {
          const verdict = decide(tool, on(ref, tool), accepted);
          if (verdict.kind !== 'allow') continue;
          expect(verdict.touched.every((id) => accepted.includes(id))).toBe(true);
          expect(verdict.touched.some((id) => id.includes('uncategorized'))).toBe(false);
        }
      }
    }
  });
});
