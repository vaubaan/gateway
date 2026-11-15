/**
 * The GitHub sign-in adapter against an in-process GitHub (no network): state and
 * PKCE, the numeric id as subject, the primary verified address, teams only when
 * the admin rule needs one, and the refusals.
 */
import { describe, expect, it } from 'vitest';

import { FakeGithub } from '../../../tests/integration/auth/fake-github';
import type { GithubSignInProvider } from '../config/sign-in';
import { LoginError } from './errors';
import { GithubSignIn, readableTeams } from './github';

const REDIRECT = new URL('https://gateway.example.com/auth/callback/github');

function setup(teams: string[] = []) {
  const fake = new FakeGithub('client', 'secret');
  const signInProvider: GithubSignInProvider = {
    kind: 'github',
    id: 'github',
    name: 'GitHub',
    issuer: fake.base,
    clientId: 'client',
    clientSecret: 'secret',
    allowedEmailDomains: [],
    invitationOnly: true,
  };
  const flow = new GithubSignIn(signInProvider, {
    redirectUri: REDIRECT,
    teams,
    fetch: fake.fetch,
  });
  return { fake, flow };
}

async function round(
  { fake, flow }: ReturnType<typeof setup>,
  tamper: (callback: URL) => void = () => undefined,
) {
  const started = await flow.start();
  const callback = fake.authorize(started.redirectTo);
  tamper(callback);
  return flow.finish(callback, started);
}

const ADA = {
  id: 42,
  login: 'ada',
  name: 'Ada',
  emails: [{ email: 'Ada@Example.com', primary: true, verified: true }],
};

describe('GitHub sign-in', () => {
  it('asks for read:user and user:email only, with state and S256 PKCE', async () => {
    const { flow } = setup();
    const started = await flow.start();
    const p = started.redirectTo.searchParams;
    expect(p.get('scope')).toBe('read:user user:email');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe(started.state);
    expect(p.get('redirect_uri')).toBe(REDIRECT.href);
    expect(started.nonce).toBe('');
  });

  it('adds read:org only when the admin rule names a team', () => {
    expect(setup(['acme/admins']).flow.scopes()).toBe('read:user user:email read:org');
    expect(setup(['not a team']).flow.scopes()).toBe('read:user user:email');
  });

  it('keys the user by the numeric id and takes the primary verified address', async () => {
    const s = setup();
    s.fake.nextUser = ADA;
    const { identity } = await round(s);
    expect(identity).toEqual({
      issuer: s.fake.issuer,
      subject: '42',
      email: 'ada@example.com',
      emailVerified: true,
      displayName: 'Ada',
      groups: [],
    });
  });

  it('reads the team of the admin rule: member, not member', async () => {
    const member = setup(['acme/admins']);
    member.fake.nextUser = { ...ADA, teams: ['acme/admins'] };
    expect((await round(member)).identity.groups).toEqual(['acme/admins']);
    const other = setup(['acme/admins']);
    other.fake.nextUser = ADA;
    expect((await round(other)).identity.groups).toEqual([]);
  });

  it('refuses a callback whose state is not the attempt’s', async () => {
    const s = setup();
    s.fake.nextUser = ADA;
    await expect(round(s, (cb) => cb.searchParams.set('state', 'forged'))).rejects.toMatchObject({
      code: 'state-mismatch',
    });
  });

  it('refuses a code exchanged without the attempt’s PKCE verifier', async () => {
    const s = setup();
    s.fake.nextUser = ADA;
    const started = await s.flow.start();
    const callback = s.fake.authorize(started.redirectTo);
    await expect(
      s.flow.finish(callback, { ...started, codeVerifier: 'x'.repeat(43) }),
    ).rejects.toMatchObject({ code: 'idp-error' });
  });

  it('refuses an unverified primary address, and an account without one', async () => {
    const unverified = setup();
    unverified.fake.nextUser = {
      ...ADA,
      emails: [
        { email: 'ada@example.com', primary: true, verified: false },
        { email: 'ada@other.example', primary: false, verified: true },
      ],
    };
    await expect(round(unverified)).rejects.toMatchObject({ code: 'email-not-verified' });
    const none = setup();
    none.fake.nextUser = { ...ADA, emails: [] };
    await expect(round(none)).rejects.toBeInstanceOf(LoginError);
  });

  it('answers an error of the sign-in provider with idp-error', async () => {
    const s = setup();
    s.fake.nextUser = ADA;
    await expect(
      round(s, (cb) => {
        cb.searchParams.delete('code');
        cb.searchParams.set('error', 'access_denied');
      }),
    ).rejects.toMatchObject({ code: 'idp-error' });
  });

  it('sorts team names it can and cannot read', () => {
    expect(readableTeams(['acme/admins', 'admins', 'a/b/c'])).toEqual({
      readable: [{ org: 'acme', team: 'admins', name: 'acme/admins' }],
      unreadable: ['admins', 'a/b/c'],
    });
  });
});
