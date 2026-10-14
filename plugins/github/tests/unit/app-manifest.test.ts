/**
 * The company's GitHub App created from a manifest: the one permission
 * declaration, the manifest per permission choice, the registration URLs,
 * the code grammar and the reading of GitHub's conversion answer. And the
 * other side of the declaration: a call the installation has no permission
 * for is declined by name, before anything is sent. No test reaches GitHub.
 */
import { describe, expect, test } from 'vitest';

import {
  checkPermissionChoice,
  defaultPermissionChoice,
  NO_ACCESS,
  toolsLostAt,
} from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  buildGithubManifest,
  GITHUB_APP_PERMISSIONS,
  githubManifestRegistration,
  githubRegisteredApp,
} from '../../src/app-manifest.ts';
import { githubCredential, GITHUB_APP_CONFIG } from '../../src/credential.ts';
import { MINT_PERMISSIONS } from '../../src/execute.ts';
import { githubPlugin } from '../../src/index.ts';
import { needsOf } from '../../src/permission-check.ts';
import { readGithubCall } from '../../src/call.ts';
import { appRepo, executeCtx, MINT_URL, TEST_PRIVATE_KEY_PEM } from './fixtures.ts';

const text = (r: { content: readonly unknown[] }) => (r.content[0] as { text: string }).text;
const permission = (name: string) => GITHUB_APP_PERMISSIONS.find((p) => p.name === name)!;

const INPUT = {
  name: 'Vaubaan gateway.acme.test',
  homepageUrl: 'https://gateway.acme.test/',
  callbackUrl: 'https://gateway.acme.test/connections/callback/github',
  redirectUrl: 'https://gateway.acme.test/admin/provider-apps/github/created',
};

describe('the permission declaration', () => {
  test('is the one the credential spec carries', () => {
    expect(githubCredential.manifestRegistration).toBe(githubManifestRegistration);
    expect(githubManifestRegistration.permissions).toBe(GITHUB_APP_PERMISSIONS);
  });

  test('names every tool of the plugin at least once', () => {
    const named = new Set(
      GITHUB_APP_PERMISSIONS.flatMap((p) => p.levels.flatMap((level) => level.tools)),
    );
    for (const tool of githubPlugin.tools) expect(named).toContain(tool.name);
    // The git remote's two tools too: a fetch reads contents, a push writes them.
    expect(named).toContain('github__git_fetch');
    expect(named).toContain('github__git_push');
  });

  test('defaults to what the tools need: every permission at its highest level', () => {
    expect(defaultPermissionChoice(GITHUB_APP_PERMISSIONS)).toEqual({
      metadata: 'read',
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      actions: 'read',
      administration: 'write',
      workflows: 'write',
    });
  });

  test('explains the three sensitive permissions', () => {
    const sensitive = GITHUB_APP_PERMISSIONS.filter((p) => p.sensitive).map((p) => p.name);
    expect(sensitive.sort()).toEqual(['administration', 'contents', 'workflows']);
  });

  test('says which tools stop working without each level', () => {
    expect(toolsLostAt(permission('workflows'), NO_ACCESS)).toContain(
      'github__create_or_update_file',
    );
    expect(toolsLostAt(permission('administration'), 'read')).toEqual([
      'github__update_branch_protection',
    ]);
    expect(toolsLostAt(permission('contents'), 'read')).toContain('github__merge_pull_request');
    expect(toolsLostAt(permission('contents'), 'read')).not.toContain('github__list_branches');
  });

  test('keeps metadata whatever the choice: GitHub grants it to every app', () => {
    const result = checkPermissionChoice(GITHUB_APP_PERMISSIONS, {});
    expect(result).toEqual({ ok: true, permissions: { metadata: 'read' } });
  });

  test('refuses a permission or a level it does not declare', () => {
    const result = checkPermissionChoice(GITHUB_APP_PERMISSIONS, {
      secrets: 'write',
      actions: 'write',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(' ')).toMatch(/'secrets' is not a permission/);
      expect(result.problems.join(' ')).toMatch(/Actions: 'write' is not one of its levels/);
    }
  });
});

describe('the manifest', () => {
  test('is private, asks for authorization on install and points at the instance', () => {
    const manifest = buildGithubManifest({ ...INPUT, permissions: { metadata: 'read' } });
    expect(manifest).toEqual({
      name: INPUT.name,
      url: INPUT.homepageUrl,
      description: expect.any(String) as unknown,
      redirect_url: INPUT.redirectUrl,
      callback_urls: [INPUT.callbackUrl],
      request_oauth_on_install: true,
      public: false,
      default_permissions: { metadata: 'read' },
    });
    // No webhook: the gateway receives none.
    expect(manifest).not.toHaveProperty('hook_attributes');
    expect(manifest).not.toHaveProperty('default_events');
    expect(manifest).not.toHaveProperty('setup_url');
  });

  test.each([
    ['the default', defaultPermissionChoice(GITHUB_APP_PERMISSIONS)],
    [
      'without the sensitive ones',
      { metadata: 'read', contents: 'read', administration: 'read', pull_requests: 'write' },
    ],
    ['the least', { metadata: 'read' }],
  ])('requests exactly the chosen permissions: %s', (_label, chosen) => {
    const checked = checkPermissionChoice(GITHUB_APP_PERMISSIONS, chosen);
    if (!checked.ok) throw new Error(checked.problems.join('; '));
    const manifest = buildGithubManifest({ ...INPUT, permissions: checked.permissions });
    expect(manifest.default_permissions).toEqual(chosen);
  });

  test('is posted to the organisation or to the personal account', () => {
    const { registrationUrl } = githubManifestRegistration;
    expect(registrationUrl({ kind: 'personal' })).toBe('https://github.com/settings/apps/new');
    expect(registrationUrl({ kind: 'organization', login: 'vaubaan' })).toBe(
      'https://github.com/organizations/vaubaan/settings/apps/new',
    );
  });

  test.each(['', '-acme', 'acme-', 'a--b', 'acme/../x', 'acme?x=1', 'a'.repeat(40), 'ac me'])(
    'never puts a malformed organisation login in a URL: %j',
    (login) => {
      expect(() =>
        githubManifestRegistration.registrationUrl({ kind: 'organization', login }),
      ).toThrow(/not an organisation login/);
    },
  );
});

describe('the code exchange', () => {
  test('is a POST path built from a well-formed code only', () => {
    const { conversionUrl } = githubManifestRegistration;
    expect(conversionUrl('a180b1a3d263c81bc6441d7b990bae27d4c10679')).toBe(
      'https://api.github.com/app-manifests/a180b1a3d263c81bc6441d7b990bae27d4c10679/conversions',
    );
    for (const bad of ['', '..', 'a/b', 'a?b', 'a b', '%2e%2e', 'x'.repeat(129)]) {
      expect(conversionUrl(bad)).toBeNull();
    }
  });

  const ANSWER = {
    id: 3870897,
    slug: 'vaubaan-gateway-acme',
    node_id: 'MDM6QXBwNTk=',
    owner: { login: 'vaubaan', type: 'Organization' },
    name: 'Vaubaan gateway.acme.test',
    html_url: 'https://github.com/apps/vaubaan-gateway-acme',
    permissions: { metadata: 'read', contents: 'write' },
    events: [],
    client_id: 'Iv23liExample',
    client_secret: 'client-secret-value',
    webhook_secret: null,
    pem: TEST_PRIVATE_KEY_PEM,
  };

  test('reads the App and every app-config field from GitHub’s answer', () => {
    expect(githubRegisteredApp(ANSWER)).toEqual({
      appConfig: {
        [GITHUB_APP_CONFIG.appId]: '3870897',
        [GITHUB_APP_CONFIG.privateKey]: TEST_PRIVATE_KEY_PEM,
        [GITHUB_APP_CONFIG.appSlug]: 'vaubaan-gateway-acme',
        [GITHUB_APP_CONFIG.clientId]: 'Iv23liExample',
        [GITHUB_APP_CONFIG.clientSecret]: 'client-secret-value',
      },
      name: 'Vaubaan gateway.acme.test',
      slug: 'vaubaan-gateway-acme',
      ownerLogin: 'vaubaan',
      htmlUrl: 'https://github.com/apps/vaubaan-gateway-acme',
      permissions: { metadata: 'read', contents: 'write' },
    });
    // Every field the credential spec asks for, and nothing else.
    const fields = githubCredential.appConfigFields.map((f) => f.name).sort();
    expect(Object.keys(githubRegisteredApp(ANSWER)!.appConfig).sort()).toEqual(fields);
  });

  test.each([
    ['no id', { id: undefined }],
    ['no private key', { pem: undefined }],
    ['not a private key', { pem: 'hello' }],
    ['no client secret', { client_secret: '' }],
    ['a slug that is not one', { slug: '../x' }],
    ['a page elsewhere than GitHub', { html_url: 'https://evil.test/apps/x' }],
    ['no owner', { owner: null }],
  ])('refuses an answer with %s', (_label, patch) => {
    expect(githubRegisteredApp({ ...ANSWER, ...patch })).toBeNull();
  });

  test('refuses what is not an object', () => {
    expect(githubRegisteredApp(null)).toBeNull();
    expect(githubRegisteredApp('{}')).toBeNull();
  });
});

describe('a call the installation has no permission for', () => {
  const grant = (permissions: Record<string, string>) => ({
    method: 'POST',
    url: MINT_URL,
    body: { token: 'ghs_call', expires_at: '2026-10-13T11:00:00Z', permissions },
  });

  test('is declined by name, before anything is sent to the repository', async () => {
    const fetch = mockFetch([grant({ metadata: 'read', contents: 'read' })]);
    const result = await githubPlugin.execute(
      executeCtx(fetch, [appRepo]),
      'github__create_branch',
      { owner: 'acme', repo: 'app', branch: 'feature/x', from_branch: 'main' },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^github__create_branch needs the GitHub App permission Contents/);
    expect(text(result)).toContain('contents: write');
    expect(text(result)).toContain('nothing was sent');
    // The token mint only: no request reached the repository.
    expect(fetch.calls.map((c) => c.url)).toEqual([MINT_URL]);
  });

  test('a file under .github/workflows/ needs Workflows; another file does not', async () => {
    const held = { metadata: 'read', contents: 'write' };
    const fetch = mockFetch([
      grant(held),
      {
        method: 'PUT',
        url: /\/contents\//,
        status: 201,
        body: { content: { path: 'README.md' }, commit: { sha: 'abc' } },
      },
    ]);
    const write = (path: string) =>
      githubPlugin.execute(executeCtx(fetch, [appRepo]), 'github__create_or_update_file', {
        owner: 'acme',
        repo: 'app',
        branch: 'feature/x',
        path,
        content: 'x',
        message: 'm',
      });
    const refused = await write('.github/workflows/ci.yml');
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('Workflows (workflows: write');
    const written = await write('README.md');
    expect(written.isError).toBeUndefined();
  });

  test('declines nothing when GitHub did not say what the installation holds', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: MINT_URL, body: { token: 't', expires_at: '2026-10-13T11:00:00Z' } },
      { method: 'GET', url: /\/branches/, body: [] },
    ]);
    const result = await githubPlugin.execute(executeCtx(fetch), 'github__list_branches', {
      owner: 'acme',
      repo: 'app',
    });
    expect(result.isError).toBeUndefined();
  });

  test('needs come from the declaration, the workflow condition from the arguments', () => {
    const call = (tool: string, args: Record<string, unknown>) => {
      const read = readGithubCall(tool, { owner: 'acme', repo: 'app', ...args }, ['acme/app']);
      if ('denied' in read) throw new Error(read.denied);
      return read;
    };
    expect(needsOf(call('github__list_tags', {}))).toEqual({ metadata: 'read' });
    expect(needsOf(call('github__merge_pull_request', { pull_number: 1 }))).toEqual({
      contents: 'write',
      pull_requests: 'write',
    });
    expect(
      needsOf(
        call('github__push_files', {
          branch: 'feature/x',
          files: [
            { path: 'a.txt', content: 'a' },
            { path: '.github/workflows/x.yml', content: 'b' },
          ],
          message: 'm',
        }),
      ),
    ).toEqual({ contents: 'write', workflows: 'write' });
  });
});

describe('the push token', () => {
  test('asks for everything first, then for what a push cannot do without', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: MINT_URL,
        status: 422,
        body: { message: 'The permissions requested are not granted to this installation.' },
        times: 1,
      },
      {
        method: 'POST',
        url: MINT_URL,
        body: {
          token: 'ghs_push',
          expires_at: '2026-10-13T11:00:00Z',
          permissions: { contents: 'write', metadata: 'read' },
        },
      },
    ]);
    const result = await githubPlugin.execute(executeCtx(fetch), 'github__mint_install_token', {
      purpose: 'push',
    });
    expect(result.isError).toBeUndefined();
    expect(fetch.calls[0]!.json).toMatchObject({ permissions: MINT_PERMISSIONS.push });
    expect(fetch.calls[1]!.json).toMatchObject({
      permissions: { contents: 'write', metadata: 'read' },
    });
  });

  test('is declined by name when even that is refused', async () => {
    const fetch = mockFetch([{ method: 'POST', url: MINT_URL, status: 422, body: {} }]);
    const result = await githubPlugin.execute(executeCtx(fetch), 'github__mint_install_token', {
      purpose: 'push',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Contents (contents: write');
    expect(fetch.calls).toHaveLength(2);
  });
});
