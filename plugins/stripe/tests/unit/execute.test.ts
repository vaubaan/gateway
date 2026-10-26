/**
 * Unit tests for `stripePlugin.execute` — the Stripe REST v1 dispatcher.
 *
 * Tests verify URL routing, HTTP method, headers, and the critical
 * `application/x-www-form-urlencoded` encoding for POST/DELETE bodies.
 * Key selection per mode and resource resolution are in `plugin.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamAuthError, type ExecuteContext, type Resource } from '@vaubaan/plugin-sdk';
import {
  mockFetch,
  type MockFetch,
  type RecordedCall,
  refusalText,
} from '@vaubaan/plugin-sdk/testing';

import { stripePlugin } from '../../src/index.ts';

const TOKEN = 'sk_test_abc123';

const testResource: Resource = {
  provider: 'stripe',
  ref: 'acct_1/test',
  env: 'test',
  displayName: 'Acme (test)',
  metadata: { account_id: 'acct_1', mode: 'test' },
};

function ctx(fetch: MockFetch): ExecuteContext {
  return {
    credential: { kind: 'api-key', fields: { test_key: TOKEN }, metadata: {} },
    fetch,
    resources: [testResource],
  };
}

/** Run one tool against a Stripe that answers `payload` to anything ; return the request sent. */
async function requestOf(
  tool: string,
  args: Record<string, unknown>,
  payload: unknown,
): Promise<RecordedCall> {
  const fetch = mockFetch([{ url: () => true, body: payload }]);
  const result = await stripePlugin.execute(ctx(fetch), tool, args);
  expect(result.isError).toBeUndefined();
  expect(fetch.calls).toHaveLength(1);
  return fetch.calls[0]!;
}

describe('execute — GET routing', () => {
  test('list_products → GET /v1/products with query params', async () => {
    const call = await requestOf('stripe__list_products', { limit: 10 }, { data: [] });
    expect(call.url).toBe('https://api.stripe.com/v1/products?limit=10');
    expect(call.method).toBe('GET');
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('list_products with no args → GET /v1/products (no query string)', async () => {
    const call = await requestOf('stripe__list_products', {}, { data: [] });
    expect(call.url).toBe('https://api.stripe.com/v1/products');
  });

  test('retrieve_customer → GET /v1/customers/:id', async () => {
    const call = await requestOf('stripe__retrieve_customer', { id: 'cus_123' }, { id: 'cus_123' });
    expect(call.url).toBe('https://api.stripe.com/v1/customers/cus_123');
    expect(call.method).toBe('GET');
  });

  test('get_balance → GET /v1/balance (no args forwarded)', async () => {
    const call = await requestOf(
      'stripe__get_balance',
      {},
      { available: [{ amount: 1000, currency: 'usd' }] },
    );
    expect(call.url).toBe('https://api.stripe.com/v1/balance');
  });

  test('list_events with type filter → GET /v1/events?type=charge.succeeded', async () => {
    const call = await requestOf(
      'stripe__list_events',
      { type: 'charge.succeeded', limit: 5 },
      { data: [] },
    );
    expect(call.url).toContain('/v1/events?');
    expect(call.url).toContain('type=charge.succeeded');
    expect(call.url).toContain('limit=5');
  });

  test('the tool result carries the Stripe payload as JSON text', async () => {
    const fetch = mockFetch([{ url: () => true, body: { data: [{ id: 'prod_1' }] } }]);
    const result = await stripePlugin.execute(ctx(fetch), 'stripe__list_products', { limit: 5 });
    const first = result.content[0] as { type: string; text: string };
    expect(JSON.parse(first.text)).toEqual({ data: [{ id: 'prod_1' }] });
  });
});

describe('execute — POST form-encoding', () => {
  test('create_product → POST /v1/products with form-encoded body', async () => {
    const call = await requestOf(
      'stripe__create_product',
      { name: 'Pro Plan', description: 'The pro plan', active: true },
      { id: 'prod_new' },
    );
    expect(call.url).toBe('https://api.stripe.com/v1/products');
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call.body).toContain('name=Pro%20Plan');
    expect(call.body).toContain('description=The%20pro%20plan');
    expect(call.body).toContain('active=true');
  });

  test('update_product → POST /v1/products/:id (id stripped from body)', async () => {
    const call = await requestOf(
      'stripe__update_product',
      { id: 'prod_x', name: 'Updated' },
      { id: 'prod_x' },
    );
    expect(call.url).toBe('https://api.stripe.com/v1/products/prod_x');
    expect(call.body).toContain('name=Updated');
    // id should NOT be in the body — it's in the URL.
    expect(call.body).not.toContain('id=prod_x');
  });

  test('create_subscription → POST /v1/subscriptions with nested items form-encoded', async () => {
    const call = await requestOf(
      'stripe__create_subscription',
      { customer: 'cus_123', items: [{ price: 'price_pro', quantity: 2 }] },
      { id: 'sub_new' },
    );
    expect(call.url).toBe('https://api.stripe.com/v1/subscriptions');
    expect(call.method).toBe('POST');
    expect(call.body).toContain('customer=cus_123');
    // Stripe bracket notation for nested arrays.
    expect(call.body).toContain('items%5B0%5D%5Bprice%5D=price_pro');
    expect(call.body).toContain('items%5B0%5D%5Bquantity%5D=2');
  });

  test('create_refund → POST /v1/refunds', async () => {
    const call = await requestOf(
      'stripe__create_refund',
      { charge: 'ch_abc', amount: 500 },
      { id: 're_new' },
    );
    expect(call.url).toBe('https://api.stripe.com/v1/refunds');
    expect(call.method).toBe('POST');
    expect(call.body).toContain('charge=ch_abc');
    expect(call.body).toContain('amount=500');
  });

  test('finalize_invoice → POST /v1/invoices/:id/finalize', async () => {
    const call = await requestOf(
      'stripe__finalize_invoice',
      { id: 'in_123' },
      { id: 'in_123', status: 'open' },
    );
    expect(call.url).toBe('https://api.stripe.com/v1/invoices/in_123/finalize');
    expect(call.method).toBe('POST');
  });

  test('void_invoice → POST /v1/invoices/:id/void', async () => {
    const call = await requestOf(
      'stripe__void_invoice',
      { id: 'in_123' },
      { id: 'in_123', status: 'void' },
    );
    expect(call.url).toBe('https://api.stripe.com/v1/invoices/in_123/void');
  });

  test('create_webhook_endpoint → POST /v1/webhook_endpoints', async () => {
    const call = await requestOf(
      'stripe__create_webhook_endpoint',
      { url: 'https://example.com/hook', enabled_events: ['charge.succeeded'] },
      { id: 'we_new', secret: 'whsec_test' },
    );
    expect(call.url).toBe('https://api.stripe.com/v1/webhook_endpoints');
    expect(call.method).toBe('POST');
    expect(call.body).toContain('url=https%3A%2F%2Fexample.com%2Fhook');
    expect(call.body).toContain('enabled_events%5B0%5D=charge.succeeded');
  });

  test('pause_subscription → POST /v1/subscriptions/:id with pause_collection', async () => {
    const call = await requestOf(
      'stripe__pause_subscription',
      { id: 'sub_x', pause_collection: { behavior: 'void' } },
      { id: 'sub_x' },
    );
    expect(call.url).toBe('https://api.stripe.com/v1/subscriptions/sub_x');
    expect(call.method).toBe('POST');
    expect(call.body).toContain('pause_collection%5Bbehavior%5D=void');
  });
});

describe('execute — only declared arguments reach Stripe', () => {
  test('an undeclared argument is dropped from a GET query', async () => {
    const call = await requestOf(
      'stripe__list_invoices',
      { customer: 'cus_1', 'expand[]': 'data.customer', expand: ['data.customer'], created: 1 },
      { data: [] },
    );
    expect(call.url).toBe('https://api.stripe.com/v1/invoices?customer=cus_1');
  });

  test('an undeclared argument is dropped from a POST body', async () => {
    const call = await requestOf(
      'stripe__create_refund',
      { charge: 'ch_abc', reverse_transfer: true, expand: ['charge.customer'] },
      { id: 're_new' },
    );
    expect(call.body).toBe('charge=ch_abc');
  });

  test('create_invoice states the draft explicitly, and forwards nothing it does not declare', async () => {
    const draft = await requestOf(
      'stripe__create_invoice',
      { customer: 'cus_1', collection_method: 'charge_automatically', pending: 'include' },
      { id: 'in_new' },
    );
    expect(draft.body).toBe('auto_advance=false&customer=cus_1');
    const advancing = await requestOf(
      'stripe__create_invoice',
      { customer: 'cus_1', auto_advance: true },
      { id: 'in_new' },
    );
    expect(advancing.body).toBe('auto_advance=true&customer=cus_1');
  });

  test('update_subscription forwards the declared cancellation fields', async () => {
    const call = await requestOf(
      'stripe__update_subscription',
      { id: 'sub_x', cancel_at_period_end: true, cancellation_details: { comment: 'x' } },
      { id: 'sub_x' },
    );
    expect(call.url).toBe('https://api.stripe.com/v1/subscriptions/sub_x');
    expect(call.body).toBe('cancel_at_period_end=true');
  });

  test('pause_subscription cannot carry a cancellation', async () => {
    const call = await requestOf(
      'stripe__pause_subscription',
      { id: 'sub_x', pause_collection: { behavior: 'void' }, cancel_at_period_end: true },
      { id: 'sub_x' },
    );
    expect(call.body).toBe('pause_collection%5Bbehavior%5D=void');
  });

  test('a path id that is missing or made of dots never becomes a collection endpoint', async () => {
    for (const id of [undefined, '', '.', '..', 42]) {
      const fetch = mockFetch([]);
      expect(
        await refusalText(stripePlugin.execute(ctx(fetch), 'stripe__update_subscription', { id })),
      ).toMatch('stripe: id: missing or malformed');
      expect(fetch.calls).toHaveLength(0);
    }
  });
});

describe('execute — DELETE routing', () => {
  test('cancel_subscription → DELETE /v1/subscriptions/:id', async () => {
    const call = await requestOf(
      'stripe__cancel_subscription',
      { id: 'sub_123' },
      { id: 'sub_123', status: 'canceled' },
    );
    expect(call.url).toBe('https://api.stripe.com/v1/subscriptions/sub_123');
    expect(call.method).toBe('DELETE');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });
});

describe('execute — error handling', () => {
  test('surfaces HTTP errors from Stripe API ; a 401 is an UpstreamAuthError', async () => {
    const fetch = mockFetch([
      { url: () => true, status: 401, body: { error: { message: 'Invalid API Key' } } },
    ]);
    const run = stripePlugin.execute(ctx(fetch), 'stripe__list_products', {});
    await expect(run).rejects.toThrow(/401/);
    await expect(run).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test('an unknown tool is an error result and sends nothing', async () => {
    const fetch = mockFetch([]);
    const result = await stripePlugin.execute(ctx(fetch), 'stripe__unknown_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: "unknown tool 'stripe__unknown_tool'",
    });
    expect(fetch.calls).toHaveLength(0);
  });
});
