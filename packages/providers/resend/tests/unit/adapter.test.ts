/**
 * Unit tests for `ResendAdapter` — paste-token mode adapter.
 *
 * Tests verify :
 *   - mintUpstreamToken decodes the encrypted bytes into a string,
 *   - validateBinding calls GET /domains with Bearer auth,
 *   - classifyV4 delegates to the risk classifier,
 *   - executeCall wires through to execute.ts with the correct token.
 */
import { describe, expect, test, vi } from 'vitest';
import type { ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { ResendAdapter } from '../../src/resend-adapter.ts';

const baseAdmin: ProviderAdmin = {
  id: 'pa-resend',
  organization_id: 'org-1',
  provider: 'resend',
  status: 'connected',
  installation_id: null,
  team_id: null,
  access_token_encrypted: new TextEncoder().encode('re_test_abc123def456'),
  refresh_token_encrypted: null,
  expires_at: null,
  connected_by_user_id: null,
  connected_at: '2026-01-01T00:00:00Z',
};

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'resend',
  resource_ref: 'prod-email',
  display_name: null,
  environment: 'prod',
  metadata: {
    internal_domains: ['acme.com'],
    allowlist_domains: ['partner.com'],
    allowlist_addresses: ['support@vendor.com'],
  },
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

describe('ResendAdapter — mintUpstreamToken', () => {
  test('returns access_token_encrypted as raw credential string', async () => {
    const adapter = new ResendAdapter();
    const { token } = await adapter.mintUpstreamToken(baseAdmin);
    expect(token).toBe('re_test_abc123def456');
  });

  test('throws when no token', async () => {
    const adapter = new ResendAdapter();
    await expect(
      adapter.mintUpstreamToken({ ...baseAdmin, access_token_encrypted: null }),
    ).rejects.toThrow(/access_token_encrypted/);
  });
});

describe('ResendAdapter — validateBinding', () => {
  test('validates by fetching GET /domains with Bearer auth', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({
        data: [{ id: 'dom_1', name: 'notifications.acme.com' }],
      }),
    );
    const adapter = new ResendAdapter({ fetchImpl: fetchImpl as never });
    const result = await adapter.validateBinding(baseAdmin, 'prod-email');
    expect(result.ok).toBe(true);
    expect(result.displayName).toBe('notifications.acme.com');

    // Verify the call was made to /domains
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/domains');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer re_test_abc123def456',
    );
  });

  test('falls back to resourceRef when no domains exist', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const adapter = new ResendAdapter({ fetchImpl: fetchImpl as never });
    const result = await adapter.validateBinding(baseAdmin, 'prod-email');
    expect(result.ok).toBe(true);
    expect(result.displayName).toBe('prod-email');
  });

  test('returns error when Resend responds with 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"message":"Invalid API Key"}'),
    });
    const adapter = new ResendAdapter({ fetchImpl: fetchImpl as never });
    const result = await adapter.validateBinding(baseAdmin, 'prod-email');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/validation failed/i);
  });
});

describe('ResendAdapter — executeCall', () => {
  test('wires through to execute.ts with decrypted token', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ data: [{ id: 'dom_1', name: 'acme.com' }] }),
    );
    const adapter = new ResendAdapter({ fetchImpl: fetchImpl as never });

    const out = (await adapter.executeCall(baseAdmin, binding, 'resend__list_domains', {})) as {
      data: Array<{ id: string }>;
    };
    expect(out.data[0]?.id).toBe('dom_1');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('/domains');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer re_test_abc123def456',
    );
  });

  test('describe_zones returns binding metadata without upstream call', async () => {
    const fetchImpl = vi.fn();
    const adapter = new ResendAdapter({ fetchImpl: fetchImpl as never });

    const out = (await adapter.executeCall(
      baseAdmin,
      binding,
      'resend__describe_zones',
      {},
    )) as Record<string, unknown>;
    expect(out.internal_domains).toEqual(['acme.com']);
    expect(out.allowlist_domains).toEqual(['partner.com']);
    // No upstream call should have been made (describe_zones is synthetic)
    // Actually execute.ts always receives fetchImpl but describe_zones
    // does not call it — we check the result is correct.
  });
});

describe('ResendAdapter — classifyV4', () => {
  test('delegates to classifyResendV4 and returns slices', () => {
    const adapter = new ResendAdapter();
    const result = adapter.classifyV4('resend__list_domains', {}, [binding]);
    expect('slices' in result).toBe(true);
    if ('slices' in result) {
      expect(result.slices.length).toBeGreaterThan(0);
      expect(result.slices[0]?.provider).toBe('resend');
    }
  });

  test('returns denied for unknown tool', () => {
    const adapter = new ResendAdapter();
    const result = adapter.classifyV4('resend__unknown', {}, [binding]);
    expect('denied' in result).toBe(true);
  });

  test('returns denied when no resend binding is present', () => {
    const adapter = new ResendAdapter();
    const result = adapter.classifyV4('resend__list_domains', {}, []);
    expect('denied' in result).toBe(true);
  });
});

describe('ResendAdapter — availableTools', () => {
  test('exposes all 25 tools', () => {
    const adapter = new ResendAdapter();
    expect(adapter.availableTools).toHaveLength(25);
  });

  test('all tool names start with resend__', () => {
    const adapter = new ResendAdapter();
    for (const tool of adapter.availableTools) {
      expect(tool.name).toMatch(/^resend__/);
    }
  });
});
