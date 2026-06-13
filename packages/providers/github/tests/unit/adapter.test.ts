import { describe, expect, test, vi } from 'vitest';
import { GitHubAdapter } from '../../src/github-adapter.ts';
import type { ProviderAdmin } from '@vaubaan/shared';

// PKCS#8 RSA-2048 test key — generated specifically for unit tests, has no
// access to anything. Same convention as @octokit's test fixtures.
const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDOg7Q7+wHk/p7d
Bme2T3pH7p9NgM31D0epDi0L7tIA+sV0w1KEh1OB7zNCsP2dgU/UDoBWmlttQ8M5
TZJk8XfwT2QvfRRGyQrR5DfMzudWKD1HFAk4zJqMI3SyvPzdM7CmKvSPzaGdyXLM
HBnFEHTrAAYpZJTLLbW2lOECG3ZsuABKQ7sQuU5GLs9CnLeUVQjy1XmwYqLF3uxL
RYNANvf++iIabHTphkPUOPkSMUDA5IfPq6CY+0e+jiosVHKLfQ1ai/CmRTUWMs8+
yQz6N+m+8GD1bqp7tH16fqp8u9eGYNvFP6hZ/9eOgrnFEavRkP86bP4ueWg+iAcZ
v7zSjjJrAgMBAAECggEAVDmwiPgRRPNQR4QAOiOLZX1ZLDGqzWsdtkAdvW1KCl4z
SAAdSWPLU/7vY7eu+T2/n+kJh4DGztYpD5DC/jpkjcrPVgrAh1qcRdJ6JFR/n+/N
WTbcvJYS9MX35qkS+nT6BgY15kuPwQ0YJOhrFGY8zk8/sZxlAGJ7QvBoshlEvJOf
nbXxQDFGM/G7gRRk8tbB1lNiPSe17/uYRjsfTAk9o32Eq6tDLR8e9pTGwlT0Vh+H
v3DSC5RcJ/Mn1bs7wKtytHnsfNgYHkwoEzeQfxIA8AhCkB99rBn9CJyzKKKQpZ06
Ku7sUMVPb/MK4OcyhHRGuW2Vk/3WBhdsfqzMHEXKMQKBgQDt6PUodMRPS+8jmTd5
qLM07VVjbqIH3LowqlBzdwH+ZINFEzsZUBVYUm1msrAPRyHGRfDlh3Z+0a5whtPj
3yWGfLGiOh23QpRC4xj9HC7TKgewWp4PE1mDpDIWLPmqMmJZS7uMLO/MnUYvLEy/
QmQEK52oqHbeJoNcFnUbR/9CtwKBgQDeQ8I3wEv3oH3SrnAVGfb+f0YjxkA0tu5l
QH48jzdHFiZ9Ipdmw6cYY26zh+UrSeJsexBjPnYR8DJa3O7ZbukOXq1c4ndU4dvb
1FOk2NRR3jcjvyiQ7DCx9Bm00pn1JCpAFXa9emR1eU7+KuYIQjvopT4G2EBSrgVf
QZBlafhxTQKBgQCx/9OFZw0/UYpYBnwLDhDDdLPMVoLuoPYDDXwZHGSp3w2c+Trh
EOOLpJ6gz72mIDIb1MKpfgIvUTOzL7vDA1xidLPnNWuBxbyfM/8+T+CHGOPTtdyu
WdoJ3LDr0PFqRYTSU1Q2YESQs6mLDpEcfm3dgRyFkPdN7Qv9MIWfk1H6tQKBgD0K
xfdGRr5MS6t/sgF7XDPYHfYdfRQnXMBGzc2nE3Y9YsP4tT5KKLPpQ7xfDTqVy0w3
4SQYUkpHr1f6FfMJgCUg9KqxlhpVgF8RbgJZyMfvljKIB6kHWGEemkF/oRdMECY2
JLQp1FpopVKDcfRGl6JV4i3rRxXGzhwYNrZN8eIBAoGAR3eN7AaTcZ5++qFTpHpP
+RaC/Z3xkNawTHK60RJoLM7VqgITAa/0kqIWyILJVjf+sZUMc+L3UVwfwzgRWnL3
P3lhCcWoarBQqXQ43RNFmqgF0kBC4O5cMrqRhEf9NwBNw0bpV7Xpr5OvVDpKKaiC
PD9rN0nWMqM6XQqyKQHGCu0=
-----END PRIVATE KEY-----`;

const baseAdmin: ProviderAdmin = {
  id: 'pa-1',
  organization_id: 'org-1',
  provider: 'github',
  status: 'connected',
  installation_id: '12345',
  team_id: null,
  access_token_encrypted: null,
  refresh_token_encrypted: null,
  expires_at: null,
  connected_by_user_id: null,
  connected_at: '2026-01-01T00:00:00Z',
};

describe('GitHubAdapter — authorizationUrl', () => {
  test('returns App install URL with state', () => {
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
    });
    const url = adapter.authorizationUrl('org-1', 'http://localhost:3000', 'st-abc');
    expect(url).toContain('https://github.com/apps/vaubaan-gateway/installations/new');
    expect(url).toContain('state=st-abc');
  });
});

describe('GitHubAdapter — mintUpstreamToken (PAT fallback)', () => {
  test('uses access_token_encrypted as Bearer when no installation_id', async () => {
    const adapter = new GitHubAdapter({});
    const patAdmin: ProviderAdmin = {
      ...baseAdmin,
      installation_id: null,
      access_token_encrypted: new TextEncoder().encode('github_pat_test_xxx'),
    };
    const { token, expiresAt } = await adapter.mintUpstreamToken(patAdmin);
    expect(token).toBe('github_pat_test_xxx');
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('throws when neither installation_id nor access_token_encrypted is set', async () => {
    const adapter = new GitHubAdapter({});
    const emptyAdmin: ProviderAdmin = {
      ...baseAdmin,
      installation_id: null,
      access_token_encrypted: null,
    };
    await expect(adapter.mintUpstreamToken(emptyAdmin)).rejects.toThrow(
      /installation_id nor access_token_encrypted/,
    );
  });

  test('throws when installation_id set but App credentials missing', async () => {
    const adapter = new GitHubAdapter({}); // no appId / privateKeyPem
    await expect(adapter.mintUpstreamToken(baseAdmin)).rejects.toThrow(
      /appId and privateKeyPem are required/,
    );
  });
});

describe('GitHubAdapter — handleCallback', () => {
  test('extracts installation_id from query', async () => {
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
    });
    const out = await adapter.handleCallback('org-1', new URLSearchParams('installation_id=99'));
    expect(out.installation_id).toBe('99');
  });

  test('rejects missing installation_id', async () => {
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
    });
    await expect(adapter.handleCallback('org-1', new URLSearchParams(''))).rejects.toThrow(
      /installation_id/,
    );
  });
});

describe('GitHubAdapter — mintUpstreamToken', () => {
  test('signs JWT and exchanges for installation token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: 'ghs_xxxxx', expires_at: '2026-05-22T11:00:00Z' }),
    });
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      fetchImpl: fetchImpl as never,
    });
    const { token, expiresAt } = await adapter.mintUpstreamToken(baseAdmin);
    expect(token).toBe('ghs_xxxxx');
    expect(expiresAt.getUTCHours()).toBe(11);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe('https://api.github.com/app/installations/12345/access_tokens');
    expect((call[1] as { headers: { Authorization: string } }).headers.Authorization).toMatch(
      /^Bearer /,
    );
  });

  test('throws on failed mint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    });
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      fetchImpl: fetchImpl as never,
    });
    await expect(adapter.mintUpstreamToken(baseAdmin)).rejects.toThrow(/404/);
  });
});

describe('GitHubAdapter — executeCall dispatch', () => {
  test('routes github__list_branches to octokit.rest.repos.listBranches', async () => {
    const listBranches = vi.fn().mockResolvedValue({ data: [{ name: 'main' }] });
    const fakeOctokit: {
      rest: { repos: { listBranches: typeof listBranches } };
      request: ReturnType<typeof vi.fn>;
    } = {
      rest: { repos: { listBranches } },
      request: vi.fn(),
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: 'ghs_xxx', expires_at: '2026-05-22T11:00:00Z' }),
    });
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      octokitFactory: () => fakeOctokit as never,
      fetchImpl: fetchImpl as never,
    });
    const result = await adapter.executeCall(
      baseAdmin,
      {
        id: 'b1',
        project_id: 'p1',
        provider: 'github',
        resource_ref: 'acme/app',
        display_name: null,
        created_at: '2026-01-01',
      },
      'github__list_branches',
      { owner: 'acme', repo: 'app' },
    );
    expect(result).toEqual([{ name: 'main' }]);
    expect(listBranches).toHaveBeenCalledWith({ owner: 'acme', repo: 'app' });
  });

  test('unknown tool throws', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: 'ghs_xxx', expires_at: '2026-05-22T11:00:00Z' }),
    });
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      octokitFactory: () => ({ rest: {}, request: vi.fn() }) as never,
      fetchImpl: fetchImpl as never,
    });
    await expect(
      adapter.executeCall(
        baseAdmin,
        {
          id: 'b1',
          project_id: 'p1',
          provider: 'github',
          resource_ref: 'acme/app',
          display_name: null,
          created_at: '2026-01-01',
        },
        'github__nonsense_tool',
        {},
      ),
    ).rejects.toThrow(/Unknown GitHub MCP tool/);
  });
});

describe('GitHubAdapter — mint_install_token', () => {
  const projectBinding = (ref: string) => ({
    id: `b-${ref}`,
    project_id: 'p1',
    provider: 'github' as const,
    resource_ref: ref,
    display_name: null,
    created_at: '2026-01-01',
  });

  function mintFetch(body: { repos?: string[]; permissions?: Record<string, string> } = {}) {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          token: 'ghs_mint_xxx',
          expires_at: '2026-05-30T12:00:00Z',
          repositories: (body.repos ?? []).map((name, i) => ({
            id: i + 1,
            name,
            full_name: `acme/${name}`,
          })),
          permissions: body.permissions ?? { contents: 'read' },
        }),
    });
  }

  test('purpose=clone scopes the token to contents:read only', async () => {
    const fetchImpl = mintFetch({ repos: ['app'], permissions: { contents: 'read' } });
    const loadGithubBindings = vi.fn().mockResolvedValue([projectBinding('acme/app')]);
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      fetchImpl: fetchImpl as never,
      loadGithubBindings,
    });
    const result = (await adapter.executeCall(
      baseAdmin,
      projectBinding('acme/app'),
      'github__mint_install_token',
      { purpose: 'clone' },
    )) as { token: string; permissions: Record<string, string> };

    expect(result.token).toBe('ghs_mint_xxx');
    const reqBody = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
      repositories: string[];
      permissions: Record<string, string>;
    };
    expect(reqBody.permissions).toEqual({ contents: 'read' });
    expect(reqBody.repositories).toEqual(['app']);
    expect(loadGithubBindings).toHaveBeenCalledWith('p1');
  });

  test('purpose=push scopes the token to contents:write + pr:write + metadata:read + workflows:write', async () => {
    const fetchImpl = mintFetch({
      repos: ['app'],
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        metadata: 'read',
        workflows: 'write',
      },
    });
    const loadGithubBindings = vi.fn().mockResolvedValue([projectBinding('acme/app')]);
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      fetchImpl: fetchImpl as never,
      loadGithubBindings,
    });
    await adapter.executeCall(baseAdmin, projectBinding('acme/app'), 'github__mint_install_token', {
      purpose: 'push',
      repoFullName: 'acme/app',
    });
    const reqBody = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
      permissions: Record<string, string>;
    };
    expect(reqBody.permissions).toEqual({
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
      workflows: 'write',
    });
  });

  test('omits repoFullName → token scoped to every github binding of the project', async () => {
    const fetchImpl = mintFetch({ repos: ['app', 'lib'] });
    const loadGithubBindings = vi
      .fn()
      .mockResolvedValue([projectBinding('acme/app'), projectBinding('acme/lib')]);
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      fetchImpl: fetchImpl as never,
      loadGithubBindings,
    });
    await adapter.executeCall(baseAdmin, projectBinding('acme/app'), 'github__mint_install_token', {
      purpose: 'clone',
    });
    const reqBody = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
      repositories: string[];
    };
    expect(reqBody.repositories).toEqual(['app', 'lib']);
  });

  test('repoFullName not in bindings → throws', async () => {
    const loadGithubBindings = vi.fn().mockResolvedValue([projectBinding('acme/app')]);
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      fetchImpl: vi.fn() as never,
      loadGithubBindings,
    });
    await expect(
      adapter.executeCall(baseAdmin, projectBinding('acme/app'), 'github__mint_install_token', {
        purpose: 'clone',
        repoFullName: 'other/repo',
      }),
    ).rejects.toThrow(/not in the project's github bindings/);
  });

  test('unknown purpose → throws before hitting GitHub', async () => {
    const fetchImpl = vi.fn();
    const loadGithubBindings = vi.fn().mockResolvedValue([projectBinding('acme/app')]);
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      fetchImpl: fetchImpl as never,
      loadGithubBindings,
    });
    await expect(
      adapter.executeCall(baseAdmin, projectBinding('acme/app'), 'github__mint_install_token', {
        purpose: 'merge',
      }),
    ).rejects.toThrow(/purpose in \['clone','push'\]/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('missing installation_id → throws', async () => {
    const adapter = new GitHubAdapter({
      appId: '123',
      appSlug: 'vaubaan-gateway',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      loadGithubBindings: vi.fn().mockResolvedValue([projectBinding('acme/app')]),
    });
    await expect(
      adapter.executeCall(
        { ...baseAdmin, installation_id: null },
        projectBinding('acme/app'),
        'github__mint_install_token',
        { purpose: 'clone' },
      ),
    ).rejects.toThrow(/installation_id/);
  });
});

describe('GitHubAdapter — classify (capability model)', () => {
  const adapter = new GitHubAdapter({
    appId: '123',
    appSlug: 'vaubaan-gateway',
    privateKeyPem: TEST_PRIVATE_KEY_PEM,
  });
  const bindings = [
    {
      id: 'b1',
      project_id: 'p1',
      provider: 'github' as const,
      resource_ref: 'acme/app',
      display_name: null,
      created_at: '2026-01-01',
    },
  ];

  test('read on a bound repo → repo/code:read (env-less)', () => {
    expect(
      adapter.classify('github__list_branches', { owner: 'acme', repo: 'app' }, bindings),
    ).toMatchObject({
      capability: { provider: 'github', plane: 'repo', level: 'code', action: 'read' },
    });
  });

  test('PR read → repo/code:read (env-less)', () => {
    expect(
      adapter.classify(
        'github__get_pull_request',
        { owner: 'acme', repo: 'app', pull_number: 1 },
        bindings,
      ),
    ).toMatchObject({
      capability: { provider: 'github', plane: 'repo', level: 'code', action: 'read' },
    });
  });

  test('write to a feature branch → repo/code:write @feature/x (env = the branch)', () => {
    expect(
      adapter.classify(
        'github__create_or_update_file',
        { owner: 'acme', repo: 'app', branch: 'feature/x', path: 'a', content: 'b', message: 'm' },
        bindings,
      ),
    ).toMatchObject({
      capability: {
        provider: 'github',
        plane: 'repo',
        level: 'code',
        action: 'write',
        env: 'feature/x',
      },
    });
  });

  test('write to a protected branch (main) → repo/code:write @main', () => {
    expect(
      adapter.classify(
        'github__push_files',
        { owner: 'acme', repo: 'app', branch: 'main', message: 'm', files: [] },
        bindings,
      ),
    ).toMatchObject({
      capability: {
        provider: 'github',
        plane: 'repo',
        level: 'code',
        action: 'write',
        env: 'main',
      },
    });
  });

  test('merge PR → repo/code:write @main (default protected branch)', () => {
    expect(
      adapter.classify(
        'github__merge_pull_request',
        { owner: 'acme', repo: 'app', pull_number: 1 },
        bindings,
      ),
    ).toMatchObject({
      capability: {
        provider: 'github',
        plane: 'repo',
        level: 'code',
        action: 'write',
        env: 'main',
      },
    });
  });

  test('create_pull_request → repo/code:write @<head branch>', () => {
    expect(
      adapter.classify(
        'github__create_pull_request',
        { owner: 'acme', repo: 'app', head: 'feature/x', base: 'main', title: 't' },
        bindings,
      ),
    ).toMatchObject({
      capability: {
        provider: 'github',
        plane: 'repo',
        level: 'code',
        action: 'write',
        env: 'feature/x',
      },
    });
  });

  test('unbound repo → denied', () => {
    const d = adapter.classify('github__list_branches', { owner: 'evil', repo: 'x' }, bindings);
    expect('denied' in d).toBe(true);
  });

  test('toolCapabilities surface for a write tool (env-less, for static filter)', () => {
    expect(adapter.toolCapabilities('github__create_or_update_file')).toEqual([
      { provider: 'github', plane: 'repo', level: 'code', action: 'write' },
    ]);
  });

  test('toolCapabilities surface for mint_install_token (both purposes)', () => {
    expect(adapter.toolCapabilities('github__mint_install_token')).toEqual([
      { provider: 'github', plane: 'repo', level: 'access', action: 'read' },
      { provider: 'github', plane: 'repo', level: 'code', action: 'write' },
    ]);
  });

  test('list_workflows → repo/ci:read (covers the ci plane)', () => {
    const d = adapter.classify('github__list_workflows', { owner: 'acme', repo: 'app' }, bindings);
    expect(d).toMatchObject({
      capability: { provider: 'github', plane: 'repo', level: 'ci', action: 'read' },
    });
  });

  test('list_workflow_runs → repo/ci:read', () => {
    const d = adapter.classify(
      'github__list_workflow_runs',
      { owner: 'acme', repo: 'app', branch: 'main' },
      bindings,
    );
    expect(d).toMatchObject({
      capability: { provider: 'github', plane: 'repo', level: 'ci', action: 'read' },
    });
  });

  test('get_branch_protection → repo/rules:read', () => {
    const d = adapter.classify(
      'github__get_branch_protection',
      { owner: 'acme', repo: 'app', branch: 'main' },
      bindings,
    );
    expect(d).toMatchObject({
      capability: { provider: 'github', plane: 'repo', level: 'rules', action: 'read' },
    });
  });

  test('classify result carries the matched binding (for excludeEnvs lookup)', () => {
    const d = adapter.classify(
      'github__create_or_update_file',
      { owner: 'acme', repo: 'app', branch: 'main', path: 'a', content: 'b', message: 'm' },
      bindings,
    );
    if ('denied' in d) throw new Error('expected capability');
    expect(d.binding?.resource_ref).toBe('acme/app');
  });
});
