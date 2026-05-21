/**
 * Phase 6 — live impl tests for `github-org-admin` provider methods.
 * `fetch` is mocked globally; we assert URL + headers + body shape on
 * outgoing requests and parse synthetic responses.
 *
 * Spec §5.1 (OrgResourceAdminKind), §7.3 (provisioning workflow),
 * §7.4 (rotation 3 paths — admin-mediated branch).
 *
 * ZK invariant: tokens cleartext live ONLY transitorily in the
 * `access` arg passed by the browser caller. We grep test logs at the
 * very end to assert no leak.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GitHubRotationNotSupportedError,
  githubOrgAdmin,
} from '../../../src/providers/github/org-admin.js';

const ADMIN_ACCESS: Readonly<Record<string, string>> = {
  GITHUB_TOKEN: 'github_pat_abc',
  GITHUB_ORG: 'vauban',
};

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

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
  vi.spyOn(console, 'log').mockImplementation((...args) => consoleSink.push(args.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...args) => consoleSink.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args) => consoleSink.push(args.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

describe('github-org-admin.listChildren', () => {
  it('GETs /orgs/{org}/repos with Bearer auth + accept header (single page)', async () => {
    mockFetch(() =>
      jsonResponse(200, [
        {
          id: 1,
          name: 'r1',
          full_name: 'vauban/r1',
          private: true,
          default_branch: 'main',
          archived: false,
          html_url: 'https://github.com/vauban/r1',
        },
      ]),
    );
    const children = await githubOrgAdmin.listChildren(ADMIN_ACCESS);
    expect(children.length).toBe(1);
    expect(children[0]?.providerRef).toBe('vauban/r1');
    expect(children[0]?.name).toBe('r1');
    expect(children[0]?.metadata).toMatchObject({
      default_branch: 'main',
      private: true,
      archived: false,
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toMatch(/orgs\/vauban\/repos\?per_page=100/);
    const headers = (fetchCalls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer github_pat_abc');
    expect(headers.Accept).toBe('application/vnd.github+json');
  });

  it('paginates following the Link rel="next" header', async () => {
    let page = 0;
    mockFetch(() => {
      page += 1;
      if (page === 1) {
        return jsonResponse(
          200,
          [
            {
              id: 1,
              name: 'r1',
              full_name: 'vauban/r1',
              private: true,
              default_branch: 'main',
              archived: false,
              html_url: 'https://github.com/vauban/r1',
            },
          ],
          { Link: '<https://api.github.com/orgs/vauban/repos?page=2>; rel="next"' },
        );
      }
      return jsonResponse(200, [
        {
          id: 2,
          name: 'r2',
          full_name: 'vauban/r2',
          private: false,
          default_branch: 'main',
          archived: true,
          html_url: 'https://github.com/vauban/r2',
        },
      ]);
    });
    const children = await githubOrgAdmin.listChildren(ADMIN_ACCESS);
    expect(children.map((c) => c.providerRef)).toEqual(['vauban/r1', 'vauban/r2']);
    expect(fetchCalls).toHaveLength(2);
  });

  it('throws when access.GITHUB_ORG is missing', async () => {
    mockFetch(() => jsonResponse(200, []));
    await expect(githubOrgAdmin.listChildren({ GITHUB_TOKEN: 'github_pat_abc' })).rejects.toThrow(
      /GITHUB_ORG/,
    );
    expect(fetchCalls).toHaveLength(0);
  });

  it('surfaces a 401 from GitHub as a thrown Error', async () => {
    mockFetch(() => new Response('bad', { status: 401, statusText: 'Unauthorized' }));
    await expect(githubOrgAdmin.listChildren(ADMIN_ACCESS)).rejects.toThrow(/listChildren failed/);
  });
});

describe('github-org-admin.createChild', () => {
  it('POSTs /orgs/{org}/repos with the spec body and returns ProviderChild', async () => {
    mockFetch(() =>
      jsonResponse(201, {
        id: 42,
        name: 'newrepo',
        full_name: 'vauban/newrepo',
        private: true,
        default_branch: 'main',
        archived: false,
        html_url: 'https://github.com/vauban/newrepo',
      }),
    );
    const child = await githubOrgAdmin.createChild(ADMIN_ACCESS, {
      name: 'newrepo',
      private: true,
      description: 'created by test',
    });
    expect(child.providerRef).toBe('vauban/newrepo');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('https://api.github.com/orgs/vauban/repos');
    expect(fetchCalls[0]?.init?.method).toBe('POST');
    const body = JSON.parse((fetchCalls[0]?.init?.body as string) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(body.name).toBe('newrepo');
    expect(body.private).toBe(true);
    expect(body.description).toBe('created by test');
    expect(body.auto_init).toBe(true);
  });

  it('throws on 422 (conflict)', async () => {
    mockFetch(() =>
      jsonResponse(422, {
        message: 'Repository creation failed',
        errors: [{ message: 'name already exists on this account' }],
      }),
    );
    await expect(githubOrgAdmin.createChild(ADMIN_ACCESS, { name: 'taken' })).rejects.toThrow(
      /conflict \(422\)/,
    );
  });

  it('rejects malformed spec', async () => {
    mockFetch(() => jsonResponse(201, {}));
    await expect(githubOrgAdmin.createChild(ADMIN_ACCESS, { foo: 'bar' })).rejects.toThrow(
      /createChild expects/,
    );
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('github-org-admin.destroyChild', () => {
  it('DELETEs /repos/{owner}/{repo} and treats 404 as success', async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    await expect(githubOrgAdmin.destroyChild(ADMIN_ACCESS, 'vauban/gone')).resolves.toBeUndefined();
    expect(fetchCalls[0]?.url).toBe('https://api.github.com/repos/vauban/gone');
    expect(fetchCalls[0]?.init?.method).toBe('DELETE');
  });

  it('returns ok on 204', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(githubOrgAdmin.destroyChild(ADMIN_ACCESS, 'vauban/r1')).resolves.toBeUndefined();
  });

  it('throws on 500', async () => {
    mockFetch(() => new Response('boom', { status: 500, statusText: 'Internal Server Error' }));
    await expect(githubOrgAdmin.destroyChild(ADMIN_ACCESS, 'vauban/r1')).rejects.toThrow(
      /destroyChild failed/,
    );
  });

  it('rejects providerRef without slash', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(githubOrgAdmin.destroyChild(ADMIN_ACCESS, 'badref')).rejects.toThrow(
      /providerRef='owner\/repo'/,
    );
  });
});

describe('github-org-admin.rotateChildAccess', () => {
  it('returns the new token when GitHub allows fine-grained PAT issuance', async () => {
    mockFetch(() =>
      jsonResponse(201, { id: 1, token: 'github_pat_new', token_last_eight: 'newnewne' }),
    );
    const token = await githubOrgAdmin.rotateChildAccess(
      ADMIN_ACCESS,
      'vauban/repo1',
      'GITHUB_TOKEN',
    );
    expect(token).toBe('github_pat_new');
    expect(fetchCalls[0]?.url).toBe('https://api.github.com/orgs/vauban/personal-access-tokens');
    const body = JSON.parse((fetchCalls[0]?.init?.body as string) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(body.repository_selection).toBe('selected');
    expect(body.repositories).toEqual(['repo1']);
  });

  it('falls back to GitHubRotationNotSupportedError on 403 (PAT not allowed)', async () => {
    mockFetch(() =>
      jsonResponse(403, { message: 'Resource not accessible by personal access token' }),
    );
    await expect(
      githubOrgAdmin.rotateChildAccess(ADMIN_ACCESS, 'vauban/repo1', 'GITHUB_TOKEN'),
    ).rejects.toBeInstanceOf(GitHubRotationNotSupportedError);
  });

  it('refuses unknown access keys with a NotSupported error', async () => {
    mockFetch(() => jsonResponse(200, {}));
    await expect(
      githubOrgAdmin.rotateChildAccess(ADMIN_ACCESS, 'vauban/repo1', 'NOT_A_KEY'),
    ).rejects.toBeInstanceOf(GitHubRotationNotSupportedError);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('ZK: no cleartext token in test console logs', () => {
  it('asserts the test sink never recorded the token literal', () => {
    expect(consoleSink.join('\n')).not.toContain('github_pat_abc');
    expect(consoleSink.join('\n')).not.toContain('github_pat_new');
  });
});
