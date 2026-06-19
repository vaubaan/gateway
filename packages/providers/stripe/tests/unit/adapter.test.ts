/**
 * Unit tests for `StripeAdapter` — paste-token mode adapter.
 *
 * Tests verify :
 *   - mintUpstreamToken decodes the encrypted bytes into a string,
 *   - validateBinding calls GET /v1/account with Bearer auth,
 *   - classifyV4 delegates to the risk classifier,
 *   - executeCall wires through to execute.ts with the correct token.
 */
import { describe, expect, test, vi } from 'vitest';
import type { ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { StripeAdapter } from '../../src/stripe-adapter.ts';

const baseAdmin: ProviderAdmin = {
  id: 'pa-stripe',
  organization_id: 'org-1',
  provider: 'stripe',
  status: 'connected',
  installation_id: null,
  team_id: null,
  access_token_encrypted: new TextEncoder().encode('sk_test_abc123def456'),
  refresh_token_encrypted: null,
  expires_at: null,
  connected_by_user_id: null,
  connected_at: '2026-01-01T00:00:00Z',
};

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'stripe',
  resource_ref: 'acct_test_123',
  display_name: null,
  environment: 'test',
  metadata: {},
  created_at: '2026-01-01',
};

/** Build a fake JSON response. */
function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

describe('StripeAdapter — mintUpstreamToken', () => {
  test('returns access_token_encrypted as raw credential string', async () => {
    const adapter = new StripeAdapter();
    const { token } = await adapter.mintUpstreamToken(baseAdmin);
    expect(token).toBe('sk_test_abc123def456');
  });

  test('throws when no token', async () => {
    const adapter = new StripeAdapter();
    await expect(
      adapter.mintUpstreamToken({ ...baseAdmin, access_token_encrypted: null }),
    ).rejects.toThrow(/access_token_encrypted/);
  });
});

describe('StripeAdapter — validateBinding', () => {
  test('validates by fetching GET /v1/account with Bearer auth', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({
        id: 'acct_test_123',
        business_profile: { name: 'My SaaS Inc.' },
      }),
    );
    const adapter = new StripeAdapter({ fetchImpl: fetchImpl as never });
    const result = await adapter.validateBinding(baseAdmin, 'acct_test_123');
    expect(result.ok).toBe(true);
    expect(result.displayName).toBe('My SaaS Inc.');

    // Verify the call was made to /v1/account
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/account');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk_test_abc123def456',
    );
  });

  test('falls back to account id when business_profile.name is absent', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'acct_test_123' }));
    const adapter = new StripeAdapter({ fetchImpl: fetchImpl as never });
    const result = await adapter.validateBinding(baseAdmin, 'acct_test_123');
    expect(result.ok).toBe(true);
    expect(result.displayName).toBe('acct_test_123');
  });

  test('returns error when Stripe responds with 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":{"message":"Invalid API Key"}}'),
    });
    const adapter = new StripeAdapter({ fetchImpl: fetchImpl as never });
    const result = await adapter.validateBinding(baseAdmin, 'acct_test_123');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/validation failed/i);
  });
});

describe('StripeAdapter — executeCall', () => {
  test('wires through to execute.ts with decrypted token', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ data: [{ id: 'prod_1' }] }),
    );
    const adapter = new StripeAdapter({ fetchImpl: fetchImpl as never });

    const out = (await adapter.executeCall(baseAdmin, binding, 'stripe__list_products', {
      limit: 5,
    })) as { data: Array<{ id: string }> };
    expect(out.data[0]?.id).toBe('prod_1');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('/v1/products');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk_test_abc123def456',
    );
  });
});

describe('StripeAdapter — classifyV4', () => {
  test('delegates to classifyStripeV4 and returns slices', () => {
    const adapter = new StripeAdapter();
    const result = adapter.classifyV4('stripe__list_products', {}, [binding]);
    expect('slices' in result).toBe(true);
    if ('slices' in result) {
      expect(result.slices.length).toBeGreaterThan(0);
      expect(result.slices[0]?.provider).toBe('stripe');
    }
  });

  test('returns denied for unknown tool', () => {
    const adapter = new StripeAdapter();
    const result = adapter.classifyV4('stripe__unknown', {}, [binding]);
    expect('denied' in result).toBe(true);
  });

  test('returns denied when no stripe binding is present', () => {
    const adapter = new StripeAdapter();
    const result = adapter.classifyV4('stripe__list_products', {}, []);
    expect('denied' in result).toBe(true);
  });
});

describe('StripeAdapter — availableTools', () => {
  test('exposes all 25 tools', () => {
    const adapter = new StripeAdapter();
    expect(adapter.availableTools).toHaveLength(25);
  });

  test('all tool names start with stripe__', () => {
    const adapter = new StripeAdapter();
    for (const tool of adapter.availableTools) {
      expect(tool.name).toMatch(/^stripe__/);
    }
  });
});
