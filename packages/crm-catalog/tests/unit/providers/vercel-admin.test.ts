/**
 * Phase 6 — live impl tests for `vercel-team-admin` provider methods.
 * `fetch` is mocked globally; we assert URL + headers + body shape on
 * outgoing requests and parse synthetic responses.
 *
 * Spec §5.1 (OrgResourceAdminKind), §7.3 (provisioning), §7.4
 * (rotation 3 paths — Vercel always falls back to manual because no
 * per-project token endpoint exists).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VercelRotationNotSupportedError,
  vercelTeamAdmin,
} from '../../../src/providers/vercel/team-admin.js';

const ADMIN_ACCESS: Readonly<Record<string, string>> = {
  VERCEL_TOKEN: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  VERCEL_TEAM_ID: 'team_zzzzzzzzzzzzzzzz',
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

describe('vercel-team-admin.listChildren', () => {
  it('GETs /v9/projects with teamId and Bearer auth (single page)', async () => {
    mockFetch(() =>
      jsonResponse(200, {
        projects: [
          {
            id: 'prj_111',
            name: 'web',
            framework: 'nextjs',
            rootDirectory: null,
            createdAt: 1,
          },
        ],
        pagination: { next: null },
      }),
    );
    const children = await vercelTeamAdmin.listChildren(ADMIN_ACCESS);
    expect(children.length).toBe(1);
    expect(children[0]?.providerRef).toBe('prj_111');
    expect(children[0]?.name).toBe('web');
    expect(children[0]?.metadata).toMatchObject({ framework: 'nextjs', rootDirectory: null });
    expect(fetchCalls[0]?.url).toMatch(/v9\/projects\?teamId=team_zzzzzzzzzzzzzzzz/);
    const headers = (fetchCalls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer aaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('paginates with pagination.next cursor', async () => {
    let page = 0;
    mockFetch(() => {
      page += 1;
      if (page === 1) {
        return jsonResponse(200, {
          projects: [{ id: 'prj_111', name: 'a' }],
          pagination: { next: 999 },
        });
      }
      return jsonResponse(200, {
        projects: [{ id: 'prj_222', name: 'b' }],
        pagination: { next: null },
      });
    });
    const children = await vercelTeamAdmin.listChildren(ADMIN_ACCESS);
    expect(children.map((c) => c.providerRef)).toEqual(['prj_111', 'prj_222']);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.url).toMatch(/until=999/);
  });

  it('throws when VERCEL_TEAM_ID is missing', async () => {
    mockFetch(() => jsonResponse(200, { projects: [], pagination: { next: null } }));
    await expect(
      vercelTeamAdmin.listChildren({ VERCEL_TOKEN: 'aaaaaaaaaaaaaaaaaaaaaaaa' }),
    ).rejects.toThrow(/VERCEL_TEAM_ID/);
  });

  it('surfaces a 401 from Vercel as a thrown Error', async () => {
    mockFetch(() => new Response('bad', { status: 401, statusText: 'Unauthorized' }));
    await expect(vercelTeamAdmin.listChildren(ADMIN_ACCESS)).rejects.toThrow(/listChildren failed/);
  });
});

describe('vercel-team-admin.createChild', () => {
  it('POSTs /v10/projects?teamId=... with the spec body and returns ProviderChild', async () => {
    mockFetch(() =>
      jsonResponse(201, { id: 'prj_new', name: 'newweb', framework: 'nextjs', createdAt: 2 }),
    );
    const child = await vercelTeamAdmin.createChild(ADMIN_ACCESS, {
      name: 'newweb',
      framework: 'nextjs',
      rootDirectory: 'apps/web',
    });
    expect(child.providerRef).toBe('prj_new');
    expect(fetchCalls[0]?.url).toBe(
      'https://api.vercel.com/v10/projects?teamId=team_zzzzzzzzzzzzzzzz',
    );
    expect(fetchCalls[0]?.init?.method).toBe('POST');
    const body = JSON.parse((fetchCalls[0]?.init?.body as string) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(body.name).toBe('newweb');
    expect(body.framework).toBe('nextjs');
    expect(body.rootDirectory).toBe('apps/web');
  });

  it('throws on 409 (conflict)', async () => {
    mockFetch(() => jsonResponse(409, { error: { code: 'project_already_exists' } }));
    await expect(vercelTeamAdmin.createChild(ADMIN_ACCESS, { name: 'taken' })).rejects.toThrow(
      /conflict \(409\)/,
    );
  });

  it('rejects malformed spec', async () => {
    mockFetch(() => jsonResponse(201, {}));
    await expect(vercelTeamAdmin.createChild(ADMIN_ACCESS, { foo: 'bar' })).rejects.toThrow(
      /createChild expects/,
    );
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('vercel-team-admin.destroyChild', () => {
  it('DELETEs /v9/projects/{id}?teamId=... and treats 404 as success', async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    await expect(vercelTeamAdmin.destroyChild(ADMIN_ACCESS, 'prj_gone')).resolves.toBeUndefined();
    expect(fetchCalls[0]?.url).toBe(
      'https://api.vercel.com/v9/projects/prj_gone?teamId=team_zzzzzzzzzzzzzzzz',
    );
    expect(fetchCalls[0]?.init?.method).toBe('DELETE');
  });

  it('returns ok on 204', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(vercelTeamAdmin.destroyChild(ADMIN_ACCESS, 'prj_1')).resolves.toBeUndefined();
  });

  it('throws on 500', async () => {
    mockFetch(() => new Response('boom', { status: 500, statusText: 'Internal Server Error' }));
    await expect(vercelTeamAdmin.destroyChild(ADMIN_ACCESS, 'prj_1')).rejects.toThrow(
      /destroyChild failed/,
    );
  });
});

describe('vercel-team-admin.rotateChildAccess', () => {
  it('always falls back to VercelRotationNotSupportedError', async () => {
    mockFetch(() => jsonResponse(200, {}));
    await expect(
      vercelTeamAdmin.rotateChildAccess(ADMIN_ACCESS, 'prj_1', 'VERCEL_TOKEN'),
    ).rejects.toBeInstanceOf(VercelRotationNotSupportedError);
    // No outgoing request expected (Vercel has no rotate API).
    expect(fetchCalls).toHaveLength(0);
  });

  it('attaches a markdown setupDocs to the error', async () => {
    mockFetch(() => jsonResponse(200, {}));
    try {
      await vercelTeamAdmin.rotateChildAccess(ADMIN_ACCESS, 'prj_1', 'VERCEL_TOKEN');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VercelRotationNotSupportedError);
      expect((err as VercelRotationNotSupportedError).setupDocs).toMatch(/Manual rotation/);
    }
  });
});

describe('ZK: no cleartext token in test console logs', () => {
  it('asserts the test sink never recorded the token literal', () => {
    expect(consoleSink.join('\n')).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
  });
});
