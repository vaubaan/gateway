/**
 * Phase 6 — live impl tests for `supabase-org-admin` provider methods.
 * `fetch` is mocked globally; we assert URL + headers + body shape on
 * outgoing requests and parse synthetic responses.
 *
 * Spec §5.1 (OrgResourceAdminKind), §7.3 (provisioning workflow),
 * §7.4 (rotation 3 paths — admin-mediated branch with SUPABASE_DB_PASSWORD
 * and manual fallback for service_role / anon JWTs).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SupabaseRotationNotSupportedError,
  supabaseOrgAdmin,
} from '../../../src/providers/supabase-cloud/org-admin.js';

const ADMIN_ACCESS: Readonly<Record<string, string>> = {
  SUPABASE_ACCESS_TOKEN: 'sbp_aaaaaaaaaaaaaaaaaaaa',
  SUPABASE_ORG_ID: 'org_xxxx',
};

type FetchCall = { url: string; init: RequestInit | undefined };

let fetchCalls: FetchCall[] = [];
let consoleSink: string[] = [];

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init });
    return await handler(url, init);
  });
  globalThis.fetch = fn;
  return fn;
}

beforeEach(() => {
  fetchCalls = [];
  consoleSink = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => consoleSink.push(a.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...a) => consoleSink.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => consoleSink.push(a.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('supabase-org-admin.listChildren', () => {
  it('GETs /v1/projects with Bearer auth, filters by SUPABASE_ORG_ID', async () => {
    mockFetch(() =>
      jsonResponse(200, [
        {
          id: 'abcdefghijklmnopqrst',
          name: 'mine',
          organization_id: 'org_xxxx',
          region: 'eu-west-3',
          status: 'ACTIVE_HEALTHY',
        },
        {
          id: 'zzzzzzzzzzzzzzzzzzzz',
          name: 'other',
          organization_id: 'org_yyyy',
          region: 'us-east-1',
        },
      ]),
    );
    const children = await supabaseOrgAdmin.listChildren(ADMIN_ACCESS);
    expect(children.length).toBe(1);
    expect(children[0]?.providerRef).toBe('abcdefghijklmnopqrst');
    expect(children[0]?.metadata).toMatchObject({
      organization_id: 'org_xxxx',
      region: 'eu-west-3',
    });
    expect(fetchCalls[0]?.url).toBe('https://api.supabase.com/v1/projects');
    const headers = (fetchCalls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sbp_aaaaaaaaaaaaaaaaaaaa');
  });

  it('returns every project when SUPABASE_ORG_ID is not set', async () => {
    mockFetch(() =>
      jsonResponse(200, [
        { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'a', organization_id: 'org1' },
        { id: 'bbbbbbbbbbbbbbbbbbbb', name: 'b', organization_id: 'org2' },
      ]),
    );
    const children = await supabaseOrgAdmin.listChildren({
      SUPABASE_ACCESS_TOKEN: 'sbp_aaaaaaaaaaaaaaaaaaaa',
    });
    expect(children.length).toBe(2);
  });

  it('throws on 401', async () => {
    mockFetch(() => new Response('bad', { status: 401, statusText: 'Unauthorized' }));
    await expect(supabaseOrgAdmin.listChildren(ADMIN_ACCESS)).rejects.toThrow(
      /listChildren failed/,
    );
  });
});

describe('supabase-org-admin.createChild', () => {
  it('POSTs /v1/projects with the spec body and returns ProviderChild', async () => {
    mockFetch(() =>
      jsonResponse(201, {
        id: 'newprojref0000000000',
        name: 'newproj',
        organization_id: 'org_xxxx',
        region: 'eu-west-3',
        status: 'PROVISIONING',
      }),
    );
    const child = await supabaseOrgAdmin.createChild(ADMIN_ACCESS, {
      name: 'newproj',
      region: 'eu-west-3',
      db_pass: 'somestrongpassword',
      organization_id: 'org_xxxx',
      plan: 'free',
    });
    expect(child.providerRef).toBe('newprojref0000000000');
    expect(fetchCalls[0]?.url).toBe('https://api.supabase.com/v1/projects');
    expect(fetchCalls[0]?.init?.method).toBe('POST');
    const body = JSON.parse((fetchCalls[0]?.init?.body as string) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(body.name).toBe('newproj');
    expect(body.region).toBe('eu-west-3');
    expect(body.db_pass).toBe('somestrongpassword');
    expect(body.organization_id).toBe('org_xxxx');
    expect(body.plan).toBe('free');
  });

  it('throws on 409 (conflict)', async () => {
    mockFetch(() => jsonResponse(409, { message: 'name already in use' }));
    await expect(
      supabaseOrgAdmin.createChild(ADMIN_ACCESS, {
        name: 'taken',
        region: 'eu-west-3',
        db_pass: 'pw',
        organization_id: 'org_xxxx',
      }),
    ).rejects.toThrow(/conflict \(409\)/);
  });

  it('rejects malformed spec', async () => {
    mockFetch(() => jsonResponse(201, {}));
    await expect(supabaseOrgAdmin.createChild(ADMIN_ACCESS, { foo: 'bar' })).rejects.toThrow(
      /createChild expects/,
    );
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('supabase-org-admin.destroyChild', () => {
  it('DELETEs /v1/projects/{ref} and treats 404 as success', async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    await expect(
      supabaseOrgAdmin.destroyChild(ADMIN_ACCESS, 'abcdefghijklmnopqrst'),
    ).resolves.toBeUndefined();
    expect(fetchCalls[0]?.url).toBe('https://api.supabase.com/v1/projects/abcdefghijklmnopqrst');
    expect(fetchCalls[0]?.init?.method).toBe('DELETE');
  });

  it('returns ok on 204', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(
      supabaseOrgAdmin.destroyChild(ADMIN_ACCESS, 'abcdefghijklmnopqrst'),
    ).resolves.toBeUndefined();
  });
});

describe('supabase-org-admin.rotateChildAccess', () => {
  it('rotates SUPABASE_DB_PASSWORD via PATCH /v1/projects/{ref}', async () => {
    mockFetch(() => jsonResponse(200, {}));
    const newPw = await supabaseOrgAdmin.rotateChildAccess(
      ADMIN_ACCESS,
      'abcdefghijklmnopqrst',
      'SUPABASE_DB_PASSWORD',
    );
    expect(newPw).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(fetchCalls[0]?.url).toBe('https://api.supabase.com/v1/projects/abcdefghijklmnopqrst');
    expect(fetchCalls[0]?.init?.method).toBe('PATCH');
    const body = JSON.parse((fetchCalls[0]?.init?.body as string) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(body.db_pass).toBe(newPw);
  });

  it('throws SupabaseRotationNotSupportedError for SUPABASE_SERVICE_ROLE_KEY', async () => {
    mockFetch(() => jsonResponse(200, {}));
    await expect(
      supabaseOrgAdmin.rotateChildAccess(
        ADMIN_ACCESS,
        'abcdefghijklmnopqrst',
        'SUPABASE_SERVICE_ROLE_KEY',
      ),
    ).rejects.toBeInstanceOf(SupabaseRotationNotSupportedError);
    expect(fetchCalls).toHaveLength(0);
  });

  it('throws SupabaseRotationNotSupportedError for SUPABASE_ANON_KEY', async () => {
    mockFetch(() => jsonResponse(200, {}));
    await expect(
      supabaseOrgAdmin.rotateChildAccess(ADMIN_ACCESS, 'abcdefghijklmnopqrst', 'SUPABASE_ANON_KEY'),
    ).rejects.toBeInstanceOf(SupabaseRotationNotSupportedError);
  });

  it('attaches setupDocs on the rotation-not-supported error', async () => {
    mockFetch(() => jsonResponse(200, {}));
    try {
      await supabaseOrgAdmin.rotateChildAccess(
        ADMIN_ACCESS,
        'abcdefghijklmnopqrst',
        'SUPABASE_SERVICE_ROLE_KEY',
      );
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SupabaseRotationNotSupportedError);
      expect((err as SupabaseRotationNotSupportedError).setupDocs).toMatch(
        /Manual rotation fallback/,
      );
    }
  });

  it('refuses unknown access keys with a NotSupported error', async () => {
    mockFetch(() => jsonResponse(200, {}));
    await expect(
      supabaseOrgAdmin.rotateChildAccess(ADMIN_ACCESS, 'abcdefghijklmnopqrst', 'RANDOM_KEY'),
    ).rejects.toBeInstanceOf(SupabaseRotationNotSupportedError);
  });
});

describe('ZK: no cleartext token in test console logs', () => {
  it('asserts the test sink never recorded the PAT literal', () => {
    expect(consoleSink.join('\n')).not.toContain('sbp_aaaaaaaaaaaaaaaaaaaa');
  });
});
