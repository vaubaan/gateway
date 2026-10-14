/**
 * The token way of connecting Supabase (`token.ts`) against `mockFetch` : the
 * check at paste, discovery and a tool call with the pasted personal access
 * token as bearer. No network.
 */
import { describe, expect, test } from 'vitest';

import {
  UpstreamAuthError,
  credentialSpecFor,
  unavailableToolReason,
  type ConnectionContext,
  type ExecuteContext,
} from '@vaubaan/plugin-sdk';
import { mockFetch, type MockFetch } from '@vaubaan/plugin-sdk/testing';

import supabasePlugin, {
  SUPABASE_API_BASE,
  supabaseTokenCredential,
  verifySupabaseToken,
} from '../../src/index.ts';

const PAT = 'sbp_fc0123456789abcdef0123456789abcdef0123';
const REF = 'tlqgxnezmthbpzhdwxgi';

function ctx(fetch: MockFetch): ConnectionContext {
  return {
    credential: { kind: 'api-key', fields: { access_token: PAT }, metadata: {} },
    appConfig: {},
    fetch,
  };
}

describe('supabase token — the declaration', () => {
  test('OAuth app first, then a personal access token; every tool runs with the token', () => {
    expect(supabasePlugin.credential.kind).toBe('oauth2');
    expect(credentialSpecFor(supabasePlugin, 'api-key')).toBe(supabaseTokenCredential);
    for (const tool of supabasePlugin.tools) {
      expect(unavailableToolReason(supabasePlugin, 'api-key', tool.name)).toBeNull();
    }
  });

  test('the field takes a personal access token and nothing else', () => {
    const pattern = new RegExp(supabaseTokenCredential.fields[0]!.pattern!);
    expect(pattern.test(PAT)).toBe(true);
    expect(pattern.test('eyJhbGciOiJIUzI1NiJ9.service_role')).toBe(false);
  });
});

describe('supabase token — verify at paste', () => {
  test('the organisations it reaches name the account; no expiry is exposed', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${SUPABASE_API_BASE}/organizations`,
        body: [{ name: 'Acme' }, { name: 'Side' }, { name: 'Third' }, { name: 'Fourth' }],
      },
    ]);
    expect(await verifySupabaseToken(ctx(fetch))).toEqual({
      account: 'Acme, Side, Third and 1 more',
      expiresAt: null,
    });
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${PAT}`);
  });

  test('a rejected token is an UpstreamAuthError', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${SUPABASE_API_BASE}/organizations`, status: 401, body: {} },
    ]);
    await expect(verifySupabaseToken(ctx(fetch))).rejects.toBeInstanceOf(UpstreamAuthError);
  });
});

describe('supabase token — discovery and execution', () => {
  test('discovery and a Management API call carry the pasted token', async () => {
    const fetch = mockFetch([
      {
        url: `${SUPABASE_API_BASE}/organizations`,
        body: [{ id: 'o', slug: 'acme', name: 'Acme' }],
      },
      {
        url: `${SUPABASE_API_BASE}/projects`,
        body: [{ id: REF, ref: REF, name: 'app', organization_slug: 'acme' }],
      },
      { method: 'GET', url: `${SUPABASE_API_BASE}/projects/${REF}`, body: { ref: REF } },
    ]);
    const resources = await supabasePlugin.discoverResources(ctx(fetch));
    expect(resources.map((r) => r.ref)).toEqual([REF]);
    const exec: ExecuteContext = { ...ctx(fetch), resources };
    const result = await supabasePlugin.execute(exec, 'supabase__get_project', {
      project_ref: REF,
    });
    expect(result.isError).toBeFalsy();
    for (const call of fetch.calls) expect(call.headers.authorization).toBe(`Bearer ${PAT}`);
  });
});
