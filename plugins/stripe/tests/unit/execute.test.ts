/**
 * Unit tests for `executeCall` — the Stripe REST v1 dispatcher.
 *
 * Tests verify URL routing, HTTP method, headers, and the critical
 * `application/x-www-form-urlencoded` encoding for POST/DELETE bodies.
 */
import { describe, expect, test, vi } from 'vitest';
import { executeCall } from '../../src/execute.ts';

const TOKEN = 'sk_test_abc123';

/** Build a fake JSON response. */
function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

/** Typed mock fetch — avoids TS2352 on `mock.calls[0]` destructuring. */
function mockFetch(response: ReturnType<typeof jsonResponse>) {
  return vi.fn(async (_url: string, _init: RequestInit) => response);
}

describe('executeCall — GET routing', () => {
  test('list_products → GET /v1/products with query params', async () => {
    const fetchImpl = mockFetch(jsonResponse({ data: [] }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__list_products', { limit: 10 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/products?limit=10');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('list_products with no args → GET /v1/products (no query string)', async () => {
    const fetchImpl = mockFetch(jsonResponse({ data: [] }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__list_products', {});
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/products');
  });

  test('retrieve_customer → GET /v1/customers/:id', async () => {
    const fetchImpl = mockFetch(jsonResponse({ id: 'cus_123' }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__retrieve_customer', { id: 'cus_123' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/customers/cus_123');
    expect(init.method).toBe('GET');
  });

  test('get_balance → GET /v1/balance (no args forwarded)', async () => {
    const fetchImpl = mockFetch(jsonResponse({ available: [{ amount: 1000, currency: 'usd' }] }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__get_balance', {});
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/balance');
  });

  test('list_events with type filter → GET /v1/events?type=charge.succeeded', async () => {
    const fetchImpl = mockFetch(jsonResponse({ data: [] }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__list_events', {
      type: 'charge.succeeded',
      limit: 5,
    });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('/v1/events?');
    expect(url).toContain('type=charge.succeeded');
    expect(url).toContain('limit=5');
  });
});

describe('executeCall — POST form-encoding', () => {
  test('create_product → POST /v1/products with form-encoded body', async () => {
    const fetchImpl = mockFetch(jsonResponse({ id: 'prod_new' }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__create_product', {
      name: 'Pro Plan',
      description: 'The pro plan',
      active: true,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/products');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = init.body as string;
    expect(body).toContain('name=Pro%20Plan');
    expect(body).toContain('description=The%20pro%20plan');
    expect(body).toContain('active=true');
  });

  test('update_product → POST /v1/products/:id (id stripped from body)', async () => {
    const fetchImpl = mockFetch(jsonResponse({ id: 'prod_x' }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__update_product', {
      id: 'prod_x',
      name: 'Updated',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/products/prod_x');
    const body = init.body as string;
    expect(body).toContain('name=Updated');
    // id should NOT be in the body — it's in the URL.
    expect(body).not.toContain('id=prod_x');
  });

  test('create_subscription → POST /v1/subscriptions with nested items form-encoded', async () => {
    const fetchImpl = mockFetch(jsonResponse({ id: 'sub_new' }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__create_subscription', {
      customer: 'cus_123',
      items: [{ price: 'price_pro', quantity: 2 }],
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/subscriptions');
    expect(init.method).toBe('POST');
    const body = init.body as string;
    expect(body).toContain('customer=cus_123');
    // Stripe bracket notation for nested arrays.
    expect(body).toContain('items%5B0%5D%5Bprice%5D=price_pro');
    expect(body).toContain('items%5B0%5D%5Bquantity%5D=2');
  });

  test('create_refund → POST /v1/refunds', async () => {
    const fetchImpl = mockFetch(jsonResponse({ id: 're_new' }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__create_refund', {
      charge: 'ch_abc',
      amount: 500,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/refunds');
    expect(init.method).toBe('POST');
    const body = init.body as string;
    expect(body).toContain('charge=ch_abc');
    expect(body).toContain('amount=500');
  });

  test('finalize_invoice → POST /v1/invoices/:id/finalize', async () => {
    const fetchImpl = mockFetch(jsonResponse({ id: 'in_123', status: 'open' }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__finalize_invoice', {
      id: 'in_123',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/invoices/in_123/finalize');
    expect(init.method).toBe('POST');
  });

  test('void_invoice → POST /v1/invoices/:id/void', async () => {
    const fetchImpl = mockFetch(jsonResponse({ id: 'in_123', status: 'void' }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__void_invoice', {
      id: 'in_123',
    });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/invoices/in_123/void');
  });

  test('create_webhook_endpoint → POST /v1/webhook_endpoints', async () => {
    const fetchImpl = mockFetch(jsonResponse({ id: 'we_new', secret: 'whsec_test' }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__create_webhook_endpoint', {
      url: 'https://example.com/hook',
      enabled_events: ['charge.succeeded'],
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/webhook_endpoints');
    expect(init.method).toBe('POST');
    const body = init.body as string;
    expect(body).toContain('url=https%3A%2F%2Fexample.com%2Fhook');
    expect(body).toContain('enabled_events%5B0%5D=charge.succeeded');
  });

  test('pause_subscription → POST /v1/subscriptions/:id with pause_collection', async () => {
    const fetchImpl = mockFetch(jsonResponse({ id: 'sub_x' }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__pause_subscription', {
      id: 'sub_x',
      pause_collection: { behavior: 'void' },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/subscriptions/sub_x');
    expect(init.method).toBe('POST');
    const body = init.body as string;
    expect(body).toContain('pause_collection%5Bbehavior%5D=void');
  });
});

describe('executeCall — DELETE routing', () => {
  test('cancel_subscription → DELETE /v1/subscriptions/:id', async () => {
    const fetchImpl = mockFetch(jsonResponse({ id: 'sub_123', status: 'canceled' }));
    await executeCall(fetchImpl as never, TOKEN, 'stripe__cancel_subscription', {
      id: 'sub_123',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/subscriptions/sub_123');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });
});

describe('executeCall — error handling', () => {
  test('surfaces HTTP errors from Stripe API', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":{"message":"Invalid API Key"}}'),
    }));
    await expect(
      executeCall(fetchImpl as never, TOKEN, 'stripe__list_products', {}),
    ).rejects.toThrow(/401/);
  });

  test('throws for unknown tool', async () => {
    const fetchImpl = vi.fn();
    await expect(
      executeCall(fetchImpl as never, TOKEN, 'stripe__unknown_tool', {}),
    ).rejects.toThrow(/not implemented/);
  });
});
