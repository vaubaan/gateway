/**
 * Identifier positions of the `stripe` plugin : every value that comes from
 * the arguments and reaches the request path, the query string, the form
 * body or a slice goes through one grammar (`stripeId`, `stripeAccountRef`
 * in `resources.ts`), in `classify` and in `execute` alike.
 *
 * The cases are the ones that turn an identifier into something else : dot
 * segments (`encodeURIComponent` leaves them and URL parsers collapse them),
 * separators, percent-escapes, query and fragment delimiters, control
 * characters, an overlong value. A refused value reaches no request.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type ExecuteContext, type Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockFetch, refusalText } from '@vaubaan/plugin-sdk/testing';

import { classifyStripe } from '../../src/classify.ts';
import { stripePlugin } from '../../src/index.ts';
import { stripeAccountRef, stripeId } from '../../src/resources.ts';

const HOSTILE: readonly string[] = [
  '..',
  '.',
  'a/../b',
  'a/b',
  '%2e%2e',
  '%2f',
  '..%2f',
  'x'.repeat(5000),
  'cus_1\nx',
  'cus_1?x=1#y',
  'cus_1\\x',
  'cus 1',
  'cus_1&expand[]=data',
  'cus_１',
];

const testResource: Resource = {
  provider: 'stripe',
  ref: 'acct_1/test',
  env: 'test',
  displayName: 'Acme (test)',
  metadata: { account_id: 'acct_1', mode: 'test' },
};

/** A Stripe that answers anything : a refusal shows as "no call", not as a mock error. */
function permissiveFetch(): MockFetch {
  return mockFetch([{ url: () => true, body: { ok: true } }]);
}

function ctx(fetch: MockFetch, resources: readonly Resource[] = [testResource]): ExecuteContext {
  return {
    credential: { kind: 'api-key', fields: { test_key: 'sk_test_abc123' }, metadata: {} },
    appConfig: {},
    fetch,
    resources,
  };
}

function classify(tool: string, args: Record<string, unknown>): string[] | { denied: string } {
  const outcome = classifyStripe(tool, args, [testResource]);
  return 'denied' in outcome ? outcome : outcome.slices.map((s) => serializeSlice(s));
}

/** Tools whose `id` is a segment of the request path. */
const PATH_ID_TOOLS: readonly string[] = [
  'stripe__retrieve_customer',
  'stripe__update_product',
  'stripe__update_price',
  'stripe__update_subscription',
  'stripe__cancel_subscription',
  'stripe__pause_subscription',
  'stripe__finalize_invoice',
  'stripe__void_invoice',
  'stripe__delete_customer',
];

/** Identifier arguments that travel in the query string or the form body, with a tool that takes each. */
const FORWARDED_IDS: ReadonlyArray<readonly [tool: string, arg: string]> = [
  ['stripe__list_prices', 'product'],
  ['stripe__create_price', 'product'],
  ['stripe__list_subscriptions', 'customer'],
  ['stripe__list_invoices', 'customer'],
  ['stripe__list_charges', 'customer'],
  ['stripe__list_charges', 'payment_intent'],
  ['stripe__list_payment_intents', 'customer'],
  ['stripe__create_subscription', 'customer'],
  ['stripe__create_invoice', 'customer'],
  ['stripe__create_promotion_code', 'coupon'],
  ['stripe__create_refund', 'charge'],
  ['stripe__create_refund', 'payment_intent'],
];

describe('the grammars', () => {
  test('stripeId accepts the ids Stripe issues and the custom ids an account chooses', () => {
    for (const id of [
      'cus_NffrFeUfNV2Hib',
      'pi_3MtwBwLkdIwHu7ix28a3tqPa',
      'acct_1032D82eZvKYlo2C',
      'prod_NWjs8kKbJWmuuc',
      'price_1MoBy5LkdIwHu7ixZhnattbh',
      'sub_1MowQVLkdIwHu7ixeRlqHVzs',
      'in_1MtHbELkdIwHu7ixl4OzzPMv',
      'ch_3MmlLrLkdIwHu7ix0snN0B15',
      'Z4OV52SU',
      'SUMMER-25',
      'com.example.pro-plan_v2',
      'a'.repeat(255),
    ]) {
      expect(stripeId(id)).toBe(id);
    }
  });

  test('stripeId refuses everything that is not one identifier', () => {
    for (const value of [...HOSTILE, '', '...', '.hidden', '-flag', 'a'.repeat(256), 42, null]) {
      expect(stripeId(value)).toBeNull();
    }
    expect(stripeId(undefined)).toBeNull();
    expect(stripeId(['cus_1'])).toBeNull();
  });

  test('stripeAccountRef accepts `<account>` and `<account>/<mode>` only', () => {
    for (const ref of ['acct_1/test', 'acct_1032D82eZvKYlo2C/live', 'acct_live']) {
      expect(stripeAccountRef(ref)).toBe(ref);
    }
    for (const ref of [
      ...HOSTILE,
      '',
      'acct_1/prod',
      'acct_1/test/live',
      '../test',
      'acct_1/',
      '/test',
      'acct.1/test',
      42,
    ]) {
      expect(stripeAccountRef(ref)).toBeNull();
    }
  });
});

describe('`id` — a segment of the request path', () => {
  for (const tool of PATH_ID_TOOLS) {
    test(`${tool} : a hostile id is refused by classify and reaches no request`, async () => {
      for (const id of HOSTILE) {
        expect(classify(tool, { id })).toEqual({ denied: 'id: malformed identifier' });
        const fetch = permissiveFetch();
        expect(await refusalText(stripePlugin.execute(ctx(fetch), tool, { id }))).toMatch(
          'stripe: id: missing or malformed',
        );
        expect(fetch.calls).toHaveLength(0);
      }
    });

    test(`${tool} : an empty or absent id never becomes the collection endpoint`, async () => {
      for (const id of ['', undefined, null]) {
        const fetch = permissiveFetch();
        expect(await refusalText(stripePlugin.execute(ctx(fetch), tool, { id }))).toMatch(
          'stripe: id: missing or malformed',
        );
        expect(fetch.calls).toHaveLength(0);
      }
    });

    test(`${tool} : the path names exactly the object the slice names`, async () => {
      const id = 'obj_1Mo.By5-Lk_d';
      const slices = classify(tool, { id });
      expect(Array.isArray(slices) && slices.some((s) => s.includes(`[${id}]`))).toBe(true);
      const fetch = permissiveFetch();
      await stripePlugin.execute(ctx(fetch), tool, { id });
      expect(fetch.calls).toHaveLength(1);
      const sent = fetch.calls[0]!.url;
      expect(sent).toMatch(
        new RegExp(`^https://api\\.stripe\\.com/v1/[a-z_]+/obj_1Mo\\.By5-Lk_d(/finalize|/void)?$`),
      );
      // What a URL parser resolves is what was written : nothing is collapsed.
      expect(new URL(sent).href).toBe(sent);
    });
  }
});

describe('identifiers that travel in the query string or the form body', () => {
  for (const [tool, arg] of FORWARDED_IDS) {
    test(`${tool}.${arg} : a hostile value is refused by classify and reaches no request`, async () => {
      for (const value of HOSTILE) {
        expect(classify(tool, { [arg]: value })).toEqual({
          denied: `${arg}: malformed identifier`,
        });
        const fetch = permissiveFetch();
        expect(await refusalText(stripePlugin.execute(ctx(fetch), tool, { [arg]: value }))).toMatch(
          `stripe: ${arg}: malformed identifier`,
        );
        expect(fetch.calls).toHaveLength(0);
      }
    });

    test(`${tool}.${arg} : the value sent is the value classified`, async () => {
      const value = 'obj_1Mo.By5-Lk_d';
      const slices = classify(tool, { [arg]: value });
      expect(Array.isArray(slices) && slices.some((s) => s.includes(`[${value}]`))).toBe(true);
      const fetch = permissiveFetch();
      await stripePlugin.execute(ctx(fetch), tool, { [arg]: value });
      expect(fetch.calls).toHaveLength(1);
      const call = fetch.calls[0]!;
      const sent =
        call.method === 'GET'
          ? new URL(call.url).searchParams.get(arg)
          : new URLSearchParams(call.body ?? '').get(arg);
      expect(sent).toBe(value);
      expect(new URL(call.url).pathname).toMatch(/^\/v1\/[a-z_]+$/);
    });
  }

  test('an empty identifier is the glob for classify and adds nothing to the path', async () => {
    expect(classify('stripe__list_invoices', { customer: '' })).toEqual([
      'stripe.account[acct_1/test].mode[test].customer[*].invoice[*].R',
      'stripe.account[acct_1/test].mode[test].customer[*].pii.R',
    ]);
    const fetch = permissiveFetch();
    await stripePlugin.execute(ctx(fetch), 'stripe__list_invoices', { customer: '' });
    expect(new URL(fetch.calls[0]!.url).pathname).toBe('/v1/invoices');
  });

  test('free-text values cannot leave their query or body field', async () => {
    const hostile = 'x&customer=cus_other#frag\n?y=1';
    const fetch = permissiveFetch();
    await stripePlugin.execute(ctx(fetch), 'stripe__list_events', { type: hostile });
    const url = new URL(fetch.calls[0]!.url);
    expect(url.pathname).toBe('/v1/events');
    expect([...url.searchParams.keys()]).toEqual(['type']);
    expect(url.searchParams.get('type')).toBe(hostile);
    expect(url.hash).toBe('');

    const post = permissiveFetch();
    await stripePlugin.execute(ctx(post), 'stripe__create_product', { name: hostile });
    const body = new URLSearchParams(post.calls[0]!.body ?? '');
    expect([...body.keys()]).toEqual(['name']);
    expect(body.get('name')).toBe(hostile);
  });
});

describe('`account` — the resource the call runs on', () => {
  test('a hostile account is refused by classify and reaches no request', async () => {
    for (const account of [...HOSTILE, '', 'acct_1/test/..', 'acct_1/live/../test']) {
      expect(classify('stripe__get_balance', { account })).toEqual({
        denied: 'account: malformed ref',
      });
      const fetch = permissiveFetch();
      expect(
        await refusalText(stripePlugin.execute(ctx(fetch), 'stripe__get_balance', { account })),
      ).toMatch('stripe: account: malformed ref');
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('the account never reaches the request : the key of its mode is all it selects', async () => {
    const fetch = permissiveFetch();
    await stripePlugin.execute(ctx(fetch), 'stripe__list_products', { account: 'acct_1/test' });
    const call = fetch.calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/products');
    expect(call.headers.authorization).toBe('Bearer sk_test_abc123');
    expect(Object.keys(call.headers).sort()).toEqual(['accept', 'authorization']);
  });

  test('a well-formed account outside the mission is refused by both', async () => {
    expect(classify('stripe__get_balance', { account: 'acct_2/test' })).toEqual({
      denied: "account: 'acct_2/test' is not a Stripe resource of this mission",
    });
    const fetch = permissiveFetch();
    expect(
      await refusalText(
        stripePlugin.execute(ctx(fetch), 'stripe__get_balance', { account: 'acct_2/test' }),
      ),
    ).toMatch('not a Stripe resource of this mission');
    expect(fetch.calls).toHaveLength(0);
  });
});
