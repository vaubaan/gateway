/**
 * The credential (`credential.ts`) : the guide the connect page shows, and the
 * check at paste against `mockFetch`.
 */
import { describe, expect, test } from 'vitest';

import { CredentialRefusal, UpstreamAuthError, type AccountContext } from '@vaubaan/plugin-sdk';
import { guideText, mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  GITHUB_API_BASE,
  GITHUB_TOKENS_PAGE,
  ORGANIZATION_FIELD,
  PROJECT_FIELD,
  TOKEN_FIELD,
  expiryOf,
  githubProjectsCredential,
  verifyGithubProjectsToken,
} from '../../src/index.ts';

const TOKEN = `github_pat_${'a'.repeat(40)}`;

const ctx = (fetch: typeof globalThis.fetch): AccountContext => ({
  credential: {
    kind: 'api-key',
    fields: { [TOKEN_FIELD]: TOKEN, [ORGANIZATION_FIELD]: 'acme', [PROJECT_FIELD]: '12' },
    metadata: {},
  },
  fetch,
});

const PROJECT_URL = `${GITHUB_API_BASE}/orgs/acme/projectsV2/12`;

describe('the GitHub Projects token — the guide', () => {
  test('links the token page, asks for the organization, every repository and Projects', () => {
    expect(githubProjectsCredential.createUrl).toBe(GITHUB_TOKENS_PAGE);
    expect(githubProjectsCredential.guide.reach.grant).toMatch(
      /All repositories, Projects read and write/,
    );
    expect(guideText(githubProjectsCredential.guide)).toMatch(/organization that owns the project/);
    expect(githubProjectsCredential.guide.permissions.map((p) => `${p.name}:${p.access}`)).toEqual([
      'Issues:read',
      'Pull requests:read',
      'Projects:read-write',
    ]);
  });

  test('refuses a classic token by the field pattern', () => {
    const field = githubProjectsCredential.fields.find((f) => f.name === TOKEN_FIELD)!;
    const pattern = new RegExp(field.pattern!);
    expect(pattern.test(TOKEN)).toBe(true);
    expect(pattern.test(`ghp_${'a'.repeat(36)}`)).toBe(false);
  });
});

describe('the GitHub Projects token — verify at paste', () => {
  test('names the account, reads the expiry, and opens the project', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${GITHUB_API_BASE}/user`,
        body: { login: 'acme-bot' },
        headers: { 'github-authentication-token-expiration': '2026-12-31 00:00:00 UTC' },
      },
      { method: 'GET', url: PROJECT_URL, body: { number: 12, title: 'Roadmap' } },
    ]);
    expect(await verifyGithubProjectsToken(ctx(fetch))).toEqual({
      account: 'acme-bot',
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
    expect(fetch.calls.map((c) => c.url)).toEqual([`${GITHUB_API_BASE}/user`, PROJECT_URL]);
    expect(fetch.calls[1]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fetch.calls[1]!.headers['x-github-api-version']).toBe('2026-03-10');
  });

  test('a project the token does not open is a CredentialRefusal', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${GITHUB_API_BASE}/user`, body: { login: 'acme-bot' } },
      { method: 'GET', url: PROJECT_URL, status: 404, body: { message: 'Not Found' } },
    ]);
    await expect(verifyGithubProjectsToken(ctx(fetch))).rejects.toBeInstanceOf(CredentialRefusal);
  });

  test('a rejected token is an UpstreamAuthError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: `${GITHUB_API_BASE}/user`, status: 401 }]);
    await expect(verifyGithubProjectsToken(ctx(fetch))).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test('an expiry GitHub does not write as expected is not guessed', () => {
    expect(expiryOf(null)).toBeNull();
    expect(expiryOf('soon')).toBeNull();
  });
});
