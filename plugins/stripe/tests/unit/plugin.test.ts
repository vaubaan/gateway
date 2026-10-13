/**
 * Mandatory suite of the Stripe plugin : the SDK kit, the v5 classifier
 * (resource resolution, mode, malformed ids, new tools), `execute` and
 * `discoverResources` against `mockFetch`, and the credential spec.
 * The v4 classifier cases live unchanged in `risk-classifier.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import {
  parseSlice,
  serializeSlice,
  type ConnectionContext,
  type ExecuteContext,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
  mockFetch,
} from '@vaubaan/plugin-sdk/testing';
import { resourceEnvResolver } from '@vaubaan/policy-engine';

import { STRIPE_API_BASE } from '../../src/execute.ts';
import { classifyStripe, modeOf, stripePlugin, stripeResourceRef } from '../../src/index.ts';

const testRes: Resource = {
  provider: 'stripe',
  ref: 'acct_1/test',
  env: 'test',
  displayName: 'Acme (test)',
  metadata: { account_id: 'acct_1', mode: 'test' },
};
const liveRes: Resource = {
  provider: 'stripe',
  ref: 'acct_1/live',
  env: 'live',
  displayName: 'Acme (live)',
  metadata: { account_id: 'acct_1', mode: 'live' },
};
const both = [testRes, liveRes];

const slices = (
  tool: string,
  args: Record<string, unknown> = {},
  resources: readonly Resource[] = [liveRes],
) => {
  const out = classifyStripe(tool, args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map(serializeSlice);
};
const denied = (
  tool: string,
  args: Record<string, unknown> = {},
  resources: readonly Resource[] = [liveRes],
) => {
  const out = classifyStripe(tool, args, resources);
  return 'denied' in out ? out.denied : null;
};

describe('stripe plugin — structural kit', () => {
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(stripePlugin);
    assertPresetsValid(stripePlugin);
    assertNoWildcard(stripePlugin);
  });

  test('every tool classifies to slices the catalog covers', () => {
    const live = 'acct_1/live';
    const report = assertCatalogCoverage(
      stripePlugin,
      {
        stripe__list_products: [{ args: {} }, { args: { account: live }, resources: both }],
        stripe__list_prices: [{ args: { product: 'prod_x' } }],
        stripe__list_customers: [{ args: {} }],
        stripe__retrieve_customer: [{ args: { id: 'cus_x' } }],
        stripe__list_subscriptions: [{ args: { customer: 'cus_x' } }],
        stripe__list_invoices: [{ args: {} }],
        stripe__list_charges: [{ args: {} }],
        stripe__list_payment_intents: [{ args: {} }],
        stripe__get_balance: [{ args: {} }],
        stripe__list_events: [{ args: {} }],
        stripe__create_product: [{ args: { name: 'Pro' } }],
        stripe__update_product: [{ args: { id: 'prod_x' } }],
        stripe__create_price: [{ args: { product: 'prod_x', unit_amount: 1, currency: 'eur' } }],
        stripe__update_price: [{ args: { id: 'price_x' } }],
        stripe__create_coupon: [{ args: { percent_off: 10 } }],
        stripe__create_promotion_code: [{ args: { coupon: 'co_x' } }],
        stripe__create_subscription: [{ args: { customer: 'cus_x', items: [] } }],
        stripe__update_subscription: [{ args: { id: 'sub_x' } }],
        stripe__cancel_subscription: [{ args: { id: 'sub_x' } }],
        stripe__pause_subscription: [{ args: { id: 'sub_x', pause_collection: {} } }],
        stripe__create_invoice: [{ args: { customer: 'cus_x' } }],
        stripe__finalize_invoice: [{ args: { id: 'in_x' } }],
        stripe__void_invoice: [{ args: { id: 'in_x' } }],
        stripe__create_refund: [{ args: { charge: 'ch_x' } }, { args: { payment_intent: 'pi_x' } }],
        stripe__create_payout: [{ args: { amount: 100, currency: 'eur' } }],
        stripe__delete_customer: [{ args: { id: 'cus_x' } }, { args: {}, expectDenied: true }],
        stripe__create_webhook_endpoint: [{ args: { url: 'https://x', enabled_events: [] } }],
      },
      { resources: [liveRes] },
    );
    expect(report.toolsChecked).toBe(27);
    // The fallback matches every write and is never dropped by the engine ; it is touched too.
    expect(report.risksUntouched).toEqual([]);
  });
});

describe('classifyStripe — resource resolution', () => {
  test('the single Stripe resource of the mission is the target', () => {
    expect(slices('stripe__get_balance', {}, [testRes])).toEqual([
      'stripe.account[acct_1/test].mode[test].balance.R',
    ]);
  });

  test('the explicit account ref picks among several resources', () => {
    expect(slices('stripe__get_balance', { account: 'acct_1/live' }, both)).toEqual([
      'stripe.account[acct_1/live].mode[live].balance.R',
    ]);
    expect(slices('stripe__get_balance', { account: 'acct_1/test' }, both)).toEqual([
      'stripe.account[acct_1/test].mode[test].balance.R',
    ]);
  });

  test('refuses an ambiguous, absent, unknown or malformed account', () => {
    expect(denied('stripe__get_balance', {}, both)).toMatch(/touches 2 Stripe resources/);
    expect(denied('stripe__get_balance', {}, [])).toMatch(/touches no Stripe resource/);
    expect(denied('stripe__get_balance', { account: 'acct_9/live' }, both)).toMatch(
      /not a Stripe resource of this mission/,
    );
    expect(denied('stripe__get_balance', { account: 'acct 1' }, both)).toBe(
      'account: malformed ref',
    );
    expect(denied('stripe__get_balance', { account: 42 }, both)).toBe('account: malformed ref');
  });

  test('ignores resources of other providers', () => {
    const other: Resource = { provider: 'github', ref: 'acme/app', displayName: 'app' };
    expect(slices('stripe__get_balance', {}, [other, testRes])).toEqual([
      'stripe.account[acct_1/test].mode[test].balance.R',
    ]);
    expect(denied('stripe__get_balance', {}, [other])).toMatch(/touches no Stripe resource/);
  });

  test('the env resolver qualifies from the ref, whichever mode the mission holds', () => {
    const resolver = resourceEnvResolver(both);
    const out = classifyStripe(
      'stripe__create_refund',
      { account: 'acct_1/live', charge: 'ch_x' },
      both,
    );
    if ('denied' in out) throw new Error(out.denied);
    expect(resolver.resolveEnv(out.slices[0]!)).toBe('live');
  });
});

describe('modeOf', () => {
  test('ref suffix wins over metadata and env ; env label alone is the v4 fallback', () => {
    expect(modeOf(liveRes)).toBe('live');
    expect(modeOf({ ...liveRes, env: 'prod' })).toBe('live');
    expect(
      modeOf({ provider: 'stripe', ref: 'acct_1', displayName: 'x', metadata: { mode: 'test' } }),
    ).toBe('test');
    expect(modeOf({ provider: 'stripe', ref: 'acct_1', env: 'live', displayName: 'x' })).toBe(
      'live',
    );
    expect(
      modeOf({ provider: 'stripe', ref: 'acct_1', env: 'production', displayName: 'x' }),
    ).toBeNull();
  });

  test('stripeResourceRef builds the ref modeOf reads back', () => {
    expect(stripeResourceRef('acct_1', 'test')).toBe('acct_1/test');
    expect(
      modeOf({ provider: 'stripe', ref: stripeResourceRef('acct_1', 'test'), displayName: 'x' }),
    ).toBe('test');
  });

  test('a resource without a determinable mode classifies to mode[*]', () => {
    const unknown: Resource = { provider: 'stripe', ref: 'acct_1', displayName: 'x' };
    expect(slices('stripe__get_balance', {}, [unknown])).toEqual([
      'stripe.account[acct_1].mode[*].balance.R',
    ]);
  });
});

describe('classifyStripe — arguments', () => {
  test('malformed identifiers are refused, never escaped', () => {
    expect(denied('stripe__retrieve_customer', { id: 'cus x' })).toBe('id: malformed identifier');
    expect(denied('stripe__create_refund', { charge: 'ch_x]' })).toBe(
      'charge: malformed identifier',
    );
    expect(denied('stripe__list_prices', { product: ['prod_x'] })).toBe(
      'product: malformed identifier',
    );
  });

  test('new v5 tools : payout and customer deletion', () => {
    expect(slices('stripe__create_payout', { amount: 100, currency: 'eur' })).toEqual([
      'stripe.account[acct_1/live].mode[live].payout.W',
    ]);
    expect(slices('stripe__delete_customer', { id: 'cus_x' })).toEqual([
      'stripe.account[acct_1/live].mode[live].customer[cus_x].delete.W',
    ]);
    expect(denied('stripe__delete_customer', {})).toBe('id: missing');
  });

  test('unknown tool is denied', () => {
    expect(denied('stripe__confirm_payment_intent', { id: 'pi_x' })).toBe(
      "unknown stripe tool 'stripe__confirm_payment_intent'.",
    );
  });

  test('emitted slices parse back (round-trip)', () => {
    for (const s of slices(
      'stripe__create_refund',
      { charge: 'ch_x', payment_intent: 'pi_x' },
      both.slice(1),
    )) {
      expect(serializeSlice(parseSlice(s))).toBe(s);
    }
  });
});

describe('executeStripe with mockFetch', () => {
  const credential = {
    kind: 'api-key' as const,
    fields: { test_key: 'sk_test_abc', live_key: 'sk_live_xyz' },
    metadata: {},
  };
  const ctx = (
    fetch: typeof globalThis.fetch,
    resources: readonly Resource[] = both,
  ): ExecuteContext => ({
    credential,
    appConfig: {},
    fetch,
    resources,
  });
  const text = (r: { content: readonly unknown[] }) => (r.content[0] as { text: string }).text;

  test('picks the live key for the live resource and strips the account argument', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${STRIPE_API_BASE}/products?limit=5`,
        body: { data: [{ id: 'prod_1' }] },
      },
    ]);
    const result = await stripePlugin.execute(ctx(fetch), 'stripe__list_products', {
      account: 'acct_1/live',
      limit: 5,
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toEqual({ data: [{ id: 'prod_1' }] });
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer sk_live_xyz');
  });

  test('picks the test key for the single test resource', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${STRIPE_API_BASE}/balance`, body: { available: [] } },
    ]);
    await stripePlugin.execute(ctx(fetch, [testRes]), 'stripe__get_balance', {});
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer sk_test_abc');
  });

  test('refuses to run without a resolvable resource or without the key of its mode', async () => {
    const fetch = mockFetch([]);
    await expect(stripePlugin.execute(ctx(fetch), 'stripe__get_balance', {})).rejects.toThrow(
      /touches 2 Stripe resources/,
    );
    const testOnly: ExecuteContext = {
      ...ctx(fetch, [liveRes]),
      credential: { kind: 'api-key', fields: { test_key: 'sk_test_abc' }, metadata: {} },
    };
    await expect(stripePlugin.execute(testOnly, 'stripe__get_balance', {})).rejects.toThrow(
      /no live-mode key/,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  test('POST is form-encoded with bracket notation ; the id goes to the path, not the body', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${STRIPE_API_BASE}/subscriptions`, body: { id: 'sub_new' } },
      { method: 'POST', url: `${STRIPE_API_BASE}/products/prod_x`, body: { id: 'prod_x' } },
    ]);
    await stripePlugin.execute(ctx(fetch, [testRes]), 'stripe__create_subscription', {
      customer: 'cus_1',
      items: [{ price: 'price_pro', quantity: 2 }],
    });
    expect(fetch.calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(fetch.calls[0]!.body).toBe(
      'customer=cus_1&items%5B0%5D%5Bprice%5D=price_pro&items%5B0%5D%5Bquantity%5D=2',
    );
    await stripePlugin.execute(ctx(fetch, [testRes]), 'stripe__update_product', {
      account: 'acct_1/test',
      id: 'prod_x',
      name: 'New',
    });
    expect(fetch.calls[1]!.body).toBe('name=New');
  });

  test('payout, customer deletion, cancel and void hit the documented endpoints', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${STRIPE_API_BASE}/payouts`, body: { id: 'po_1' } },
      { method: 'DELETE', url: `${STRIPE_API_BASE}/customers/cus_x`, body: { deleted: true } },
      {
        method: 'DELETE',
        url: `${STRIPE_API_BASE}/subscriptions/sub_x`,
        body: { status: 'canceled' },
      },
      { method: 'POST', url: `${STRIPE_API_BASE}/invoices/in_x/void`, body: { status: 'void' } },
    ]);
    const c = ctx(fetch, [liveRes]);
    await stripePlugin.execute(c, 'stripe__create_payout', { amount: 1100, currency: 'usd' });
    await stripePlugin.execute(c, 'stripe__delete_customer', { id: 'cus_x' });
    await stripePlugin.execute(c, 'stripe__cancel_subscription', { id: 'sub_x' });
    await stripePlugin.execute(c, 'stripe__void_invoice', { id: 'in_x' });
    expect(fetch.calls[0]!.body).toBe('amount=1100&currency=usd');
    expect(fetch.calls[1]!.body).toBeNull();
    expect(fetch.calls[3]!.body).toBeNull();
    expect(fetch.pending()).toEqual([]);
  });

  test('401 and 403 become UpstreamAuthError ; other errors are plain', async () => {
    const fetch = mockFetch([
      { url: /\/balance$/, status: 401, body: { error: { message: 'Invalid API Key' } } },
      { url: /\/products$/, status: 429, body: { error: { message: 'slow down' } } },
    ]);
    await expect(
      stripePlugin.execute(ctx(fetch, [liveRes]), 'stripe__get_balance', {}),
    ).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
    await expect(
      stripePlugin.execute(ctx(fetch, [liveRes]), 'stripe__list_products', {}),
    ).rejects.toThrow(/429/);
  });

  test('unknown tool is an error result, not a call', async () => {
    const fetch = mockFetch([]);
    const result = await stripePlugin.execute(ctx(fetch, [liveRes]), 'stripe__nope', {});
    expect(result.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('discoverStripeResources with mockFetch', () => {
  const ctx = (
    fetch: typeof globalThis.fetch,
    fields: Record<string, string>,
  ): ConnectionContext => ({
    credential: { kind: 'api-key', fields, metadata: {} },
    appConfig: {},
    fetch,
  });
  const account = (name: string | null, display: string | null = null) => ({
    id: 'acct_1',
    business_profile: { name },
    settings: { dashboard: { display_name: display } },
  });

  test('one resource per key, env = mode, ref = account/mode, one GET /account per key', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${STRIPE_API_BASE}/account`,
        respond: (call) =>
          call.headers.authorization === 'Bearer sk_live_xyz'
            ? account('Acme Inc.', 'Acme')
            : account('Acme Inc.'),
        times: 2,
      },
    ]);
    const resources = await stripePlugin.discoverResources(
      ctx(fetch, { test_key: 'sk_test_abc', live_key: 'sk_live_xyz' }),
    );
    expect(resources).toEqual([
      {
        provider: 'stripe',
        ref: 'acct_1/test',
        env: 'test',
        displayName: 'Acme Inc. (test)',
        metadata: { account_id: 'acct_1', mode: 'test' },
      },
      {
        provider: 'stripe',
        ref: 'acct_1/live',
        env: 'live',
        displayName: 'Acme (live)',
        metadata: { account_id: 'acct_1', mode: 'live' },
      },
    ]);
    expect(fetch.calls.map((c) => c.headers.authorization)).toEqual([
      'Bearer sk_test_abc',
      'Bearer sk_live_xyz',
    ]);
  });

  test('a test-only credential yields the test resource only ; the id is the fallback label', async () => {
    const fetch = mockFetch([{ url: `${STRIPE_API_BASE}/account`, body: account(null) }]);
    const resources = await stripePlugin.discoverResources(ctx(fetch, { test_key: 'rk_test_abc' }));
    expect(resources.map((r) => [r.ref, r.displayName])).toEqual([
      ['acct_1/test', 'acct_1 (test)'],
    ]);
  });

  test('refuses a key pasted in the wrong field, and a credential with no key at all', async () => {
    const fetch = mockFetch([]);
    await expect(
      stripePlugin.discoverResources(ctx(fetch, { test_key: 'sk_live_xyz' })),
    ).rejects.toThrow(/test_key must be a test-mode key/);
    await expect(stripePlugin.discoverResources(ctx(fetch, {}))).rejects.toThrow(
      /neither a test key nor a live key/,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  test('a rejected key surfaces as UpstreamAuthError', async () => {
    const fetch = mockFetch([
      { url: /\/account$/, status: 401, body: { error: { message: 'Invalid API Key' } } },
    ]);
    await expect(
      stripePlugin.discoverResources(ctx(fetch, { live_key: 'sk_live_bad' })),
    ).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
  });

  test('refuses a secret of another kind', async () => {
    const fetch = mockFetch([]);
    const oauth: ConnectionContext = {
      credential: {
        kind: 'oauth2',
        accessToken: 't',
        refreshToken: null,
        expiresAt: null,
        scopes: [],
        metadata: {},
      },
      appConfig: {},
      fetch,
    };
    await expect(stripePlugin.discoverResources(oauth)).rejects.toMatchObject({
      name: 'CredentialKindMismatch',
    });
  });
});

describe('credential spec', () => {
  test('api-key with two optional secret fields, each pinned to its mode by pattern', () => {
    const spec = stripePlugin.credential;
    expect(spec.kind).toBe('api-key');
    if (spec.kind !== 'api-key') return;
    expect(spec.fields.map((f) => f.name)).toEqual(['test_key', 'live_key']);
    for (const field of spec.fields) {
      expect(field.secret).toBe(true);
      expect(field.required).toBe(false);
    }
    const [testField, liveField] = spec.fields;
    expect(new RegExp(testField!.pattern).test('sk_test_abc')).toBe(true);
    expect(new RegExp(testField!.pattern).test('rk_test_abc')).toBe(true);
    expect(new RegExp(testField!.pattern).test('sk_live_abc')).toBe(false);
    expect(new RegExp(liveField!.pattern).test('sk_live_abc')).toBe(true);
    expect(new RegExp(liveField!.pattern).test('sk_test_abc')).toBe(false);
  });

  test('presets : the three the brief asks for, approval on the live money-out and irreversible entries', () => {
    const presets = stripePlugin.catalog.presets;
    expect(presets.map((p) => p.id)).toEqual([
      'read-only',
      'test-mode-developer',
      'finance-operator',
    ]);
    const finance = presets.find((p) => p.id === 'finance-operator')!;
    const approval = finance.entries
      .filter((e) => e.gate === 'approval')
      .map((e) => e.risk_id)
      .sort();
    expect(approval).toEqual([
      'stripe[live].customer-delete',
      'stripe[live].invoice-void',
      'stripe[live].payout-create',
      'stripe[live].refund-create',
      'stripe[live].subscription-cancel',
    ]);
    const dev = presets.find((p) => p.id === 'test-mode-developer')!;
    expect(dev.entries.every((e) => e.risk_id.startsWith('stripe[test].'))).toBe(true);
    const ro = presets.find((p) => p.id === 'read-only')!;
    expect(ro.entries.map((e) => e.risk_id)).not.toContain('stripe.read-customer-pii');
  });
});
