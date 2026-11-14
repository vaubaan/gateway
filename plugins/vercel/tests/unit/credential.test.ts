/**
 * The Vercel access token (`credential.ts`) against `mockFetch` : the guide
 * the connect page shows and the check at paste.
 */
import { describe, expect, test } from 'vitest';

import {
  CredentialRefusal,
  UpstreamAuthError,
  UpstreamProtocolError,
  type AccountContext,
} from '@vaubaan/plugin-sdk';
import { guideText, mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import {
  VERCEL_API_BASE,
  VERCEL_TOKENS_URL,
  vercelCredential,
  verifyVercelToken,
} from '../../src/index.ts';

const CURRENT = `${VERCEL_API_BASE}/v5/user/tokens/current`;
const TEAM = `${VERCEL_API_BASE}/v2/teams/team_abc`;

const PROJECT = `${VERCEL_API_BASE}/v9/projects/prj_app`;

const ctx = (
  fetch: typeof globalThis.fetch,
  fields: Record<string, string> = { token: 'vcp_secret', team_id: 'team_abc' },
): AccountContext => ({
  credential: { kind: 'api-key', fields, metadata: {} },
  fetch,
});

const projectCtx = (fetch: typeof globalThis.fetch): AccountContext =>
  ctx(fetch, { token: 'vcp_secret', project_id: 'prj_app' });

const current = (token: Record<string, unknown>): MockRoute => ({
  method: 'GET',
  url: CURRENT,
  body: { token: { id: 'tk_1', name: 'gateway', ...token } },
});

describe('vercel token — the guide', () => {
  const [project, team] = vercelCredential.alternatives!;

  test('two alternatives, the narrowest first: one project, or the team with All Projects', () => {
    expect(vercelCredential.createUrl).toBe(VERCEL_TOKENS_URL);
    expect(vercelCredential.alternatives!.map((a) => [a.id, a.label, a.fields])).toEqual([
      ['project', 'One project', ['project_id']],
      ['team', 'Team', ['team_id']],
    ]);
    expect(vercelCredential.guide.reach.grant).toBe('One project, or the team with All Projects');
    expect(vercelCredential.guide.reach.why).toMatch(
      /^A key per project keeps a leak or a mistake inside that project/,
    );
    expect(vercelCredential.guide.expiry).toEqual({ kind: 'provider-reports' });
  });

  test('each alternative reads its ID first, then scopes the token', () => {
    const tokensStep = ['Account Settings', 'Tokens'];
    const teamPaths = team!.steps.map((step) => step.path);
    expect(teamPaths.findIndex((path) => path?.includes('Team ID'))).toBeGreaterThan(-1);
    expect(teamPaths.findIndex((path) => path?.includes('Team ID'))).toBeLessThan(
      teamPaths.findIndex((path) => path?.join() === tokensStep.join()),
    );
    expect(guideText({ ...vercelCredential.guide, steps: [] }, [team!])).toMatch(
      /Choose the team, then All Projects/,
    );
    const projectPaths = project!.steps.map((step) => step.path);
    expect(projectPaths.findIndex((path) => path?.includes('Project ID'))).toBeGreaterThan(-1);
    expect(projectPaths.findIndex((path) => path?.includes('Project ID'))).toBeLessThan(
      projectPaths.findIndex((path) => path?.join() === tokensStep.join()),
    );
    expect(guideText({ ...vercelCredential.guide, steps: [] }, [project!])).toMatch(
      /then the project/,
    );
  });
});

describe('vercel token — verify at paste', () => {
  test('names the team the token opens and reads the expiry', async () => {
    const fetch = mockFetch([
      current({ expiresAt: Date.UTC(2027, 0, 31) }),
      { method: 'GET', url: TEAM, body: { id: 'team_abc', name: 'Acme', slug: 'acme' } },
    ]);
    expect(await verifyVercelToken(ctx(fetch))).toEqual({
      account: 'the Acme team',
      expiresAt: '2027-01-31T00:00:00.000Z',
    });
    expect(fetch.calls.every((c) => c.headers.authorization === 'Bearer vcp_secret')).toBe(true);
  });

  test('a token without expiration has none', async () => {
    const fetch = mockFetch([current({}), { method: 'GET', url: TEAM, body: { slug: 'acme' } }]);
    expect(await verifyVercelToken(ctx(fetch))).toEqual({
      account: 'the acme team',
      expiresAt: null,
    });
  });

  test('a token refused the team (403) may be scoped to one project: says to choose One project', async () => {
    const fetch = mockFetch([current({}), { method: 'GET', url: TEAM, status: 403, body: {} }]);
    const check = verifyVercelToken(ctx(fetch));
    await expect(check).rejects.toBeInstanceOf(CredentialRefusal);
    await expect(check).rejects.toThrow(
      'Vercel: this token does not cover the whole team team_abc (it may be scoped to one project): choose One project, or recreate it with the team and All Projects.',
    );
  });

  test('a Team ID Vercel does not know (404) is refused as such', async () => {
    const fetch = mockFetch([current({}), { method: 'GET', url: TEAM, status: 404, body: {} }]);
    const check = verifyVercelToken(ctx(fetch));
    await expect(check).rejects.toBeInstanceOf(CredentialRefusal);
    await expect(check).rejects.toThrow(/no team with the ID team_abc/);
  });

  test('a project token: names the project, read without teamId, and reads the expiry', async () => {
    const fetch = mockFetch([
      current({ expiresAt: Date.UTC(2027, 0, 31) }),
      { method: 'GET', url: PROJECT, body: { id: 'prj_app', name: 'site', accountId: 'team_abc' } },
    ]);
    expect(await verifyVercelToken(projectCtx(fetch))).toEqual({
      account: 'the site project',
      expiresAt: '2027-01-31T00:00:00.000Z',
    });
    expect(fetch.calls.map((c) => c.url)).toEqual([CURRENT, PROJECT]);
  });

  test.each([403, 404])(
    'a project the token does not open (HTTP %i) is refused with the scope to choose',
    async (status) => {
      const fetch = mockFetch([current({}), { method: 'GET', url: PROJECT, status, body: {} }]);
      const check = verifyVercelToken(projectCtx(fetch));
      await expect(check).rejects.toBeInstanceOf(CredentialRefusal);
      await expect(check).rejects.toThrow(
        /does not open the project prj_app.*the team that owns it, then that project/,
      );
    },
  );

  test('a rejected token is an UpstreamAuthError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: CURRENT, status: 401, body: {} }]);
    const check = verifyVercelToken(ctx(fetch));
    await expect(check).rejects.toBeInstanceOf(UpstreamAuthError);
    await expect(check).rejects.not.toBeInstanceOf(CredentialRefusal);
  });

  test('an answer that is not JSON is an UpstreamProtocolError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: CURRENT, body: '<html>' }]);
    await expect(verifyVercelToken(ctx(fetch))).rejects.toBeInstanceOf(UpstreamProtocolError);
  });
});
