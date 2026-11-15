import { describe, expect, it, vi } from 'vitest';

import type { UserRecord } from '../store/types';
import type { AdminDecision, Principal, UserPrincipal } from './authenticator';
import {
  guardMutation,
  guardSession,
  OPERATOR_REFUSALS,
  refusalResponse,
  type GuardDeps,
} from './guard';

const PUBLIC_URL = new URL('https://gateway.example.com');

function userPrincipal(isOperator: boolean): UserPrincipal {
  const user = { id: 'user-1', email: 'ada@example.com' } as UserRecord;
  return {
    kind: 'user',
    sessionId: 'session-1',
    user,
    groups: [],
    isOperator,
    signInProviderId: 'idp',
    login: { email: user.email, groups: [] },
  };
}

const BOOTSTRAP: Principal = { kind: 'bootstrap', sessionId: 'session-b' };

/** The admin rule as `Authenticator.authorizeAdmin` states it. */
async function authorizeAdmin(principal: Principal | null): Promise<AdminDecision> {
  if (!principal) return { ok: false, status: 401, reason: 'no session' };
  if (principal.kind === 'bootstrap' || principal.isOperator) return { ok: true, principal };
  return { ok: false, status: 403, reason: 'user is not an administrator of this instance' };
}

function depsFor(principal: Principal | null) {
  const authenticate = vi.fn(async () => principal);
  const deps: GuardDeps = {
    publicUrl: PUBLIC_URL,
    authenticator: { authenticate, authorizeAdmin },
  };
  return { deps, authenticate };
}

function request(headers: Record<string, string> = { origin: PUBLIC_URL.origin }): Request {
  return new Request(`${PUBLIC_URL.origin}/api/anything`, { method: 'POST', headers });
}

describe('guardMutation', () => {
  it.each([
    ['another origin', { origin: 'https://evil.example' }],
    ['no Origin and no Referer', {}],
    ['an opaque Origin', { origin: 'null' }],
    ['the Referer of another site', { referer: 'https://evil.example/page' }],
  ])('refuses %s before the session is read', async (_case, headers) => {
    const { deps, authenticate } = depsFor(userPrincipal(true));
    for (const role of ['user', 'operator'] as const) {
      const result =
        role === 'user'
          ? await guardMutation(request(headers), deps, 'user')
          : await guardMutation(request(headers), deps, 'operator');
      expect(result).toEqual({ ok: false, reason: 'origin-mismatch', status: 403 });
    }
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('accepts a same-origin Referer when the browser sent no Origin', async () => {
    const { deps } = depsFor(userPrincipal(false));
    const result = await guardMutation(
      request({ referer: `${PUBLIC_URL.origin}/missions/new` }),
      deps,
      'user',
    );
    expect(result.ok).toBe(true);
  });

  it('refuses nobody with 401, whatever the role', async () => {
    const { deps } = depsFor(null);
    const refusal = { ok: false, reason: 'no-session', status: 401 };
    expect(await guardMutation(request(), deps, 'user')).toEqual(refusal);
    expect(await guardMutation(request(), deps, 'operator')).toEqual(refusal);
  });

  it('user role: a user passes, operator or not; the bootstrap operator does not', async () => {
    for (const isOperator of [false, true]) {
      const principal = userPrincipal(isOperator);
      const result = await guardMutation(request(), depsFor(principal).deps, 'user');
      expect(result).toEqual({ ok: true, principal });
    }
    expect(await guardMutation(request(), depsFor(BOOTSTRAP).deps, 'user')).toEqual({
      ok: false,
      reason: 'not-a-user',
      status: 403,
    });
  });

  it('operator role: the admin rule decides', async () => {
    const operator = userPrincipal(true);
    expect(await guardMutation(request(), depsFor(operator).deps, 'operator')).toEqual({
      ok: true,
      principal: operator,
    });
    expect(await guardMutation(request(), depsFor(BOOTSTRAP).deps, 'operator')).toEqual({
      ok: true,
      principal: BOOTSTRAP,
    });
    expect(await guardMutation(request(), depsFor(userPrincipal(false)).deps, 'operator')).toEqual({
      ok: false,
      reason: 'not-an-operator',
      status: 403,
    });
  });
});

describe('guardSession', () => {
  it('checks the session and the role, not the origin (reads)', async () => {
    const principal = userPrincipal(false);
    const get = new Request(`${PUBLIC_URL.origin}/api/requests`);
    expect(await guardSession(get, depsFor(principal).deps, 'user')).toEqual({
      ok: true,
      principal,
    });
    expect(await guardSession(get, depsFor(null).deps, 'user')).toMatchObject({
      reason: 'no-session',
    });
    expect(await guardSession(get, depsFor(BOOTSTRAP).deps, 'user')).toMatchObject({
      reason: 'not-a-user',
    });
    expect(await guardSession(get, depsFor(principal).deps, 'operator')).toMatchObject({
      reason: 'not-an-operator',
    });
  });
});

describe('refusalResponse', () => {
  const wording = {
    field: 'message',
    noSession: 'Sign in first.',
    forbidden: 'Not yours.',
  } as const;

  it('words each refusal with the surface’s sentences, never cached', async () => {
    const origin = refusalResponse({ ok: false, reason: 'origin-mismatch', status: 403 }, wording);
    expect(origin.status).toBe(403);
    expect(await origin.json()).toMatchObject({ error: 'origin-mismatch' });

    const nobody = refusalResponse({ ok: false, reason: 'no-session', status: 401 }, wording);
    expect(nobody.status).toBe(401);
    expect(nobody.headers.get('cache-control')).toBe('no-store');
    expect(await nobody.json()).toEqual({ error: 'unauthenticated', message: 'Sign in first.' });

    const wrongRole = refusalResponse({ ok: false, reason: 'not-a-user', status: 403 }, wording);
    expect(await wrongRole.json()).toEqual({ error: 'forbidden', message: 'Not yours.' });

    const admin = refusalResponse(
      { ok: false, reason: 'not-an-operator', status: 403 },
      OPERATOR_REFUSALS,
    );
    expect(await admin.json()).toEqual({
      error: 'forbidden',
      reason: 'user is not an administrator of this instance',
    });
  });
});

describe('a page’s form posted without a session', () => {
  const page = `${PUBLIC_URL.origin}/accounts/c-1?tab=resources`;

  async function refusalOf(headers: Record<string, string>): Promise<Response> {
    const refusal = await guardMutation(
      request({ origin: PUBLIC_URL.origin, ...headers }),
      depsFor(null).deps,
      'user',
    );
    if (refusal.ok) throw new Error('expected a refusal');
    return refusalResponse(refusal, OPERATOR_REFUSALS);
  }

  it('is sent to sign in, then back to the page it came from', async () => {
    const response = await refusalOf({ 'sec-fetch-mode': 'navigate', referer: page });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `/login?return_to=${encodeURIComponent('/accounts/c-1?tab=resources')}`,
    );
  });

  it('a page of another origin is not returned to', async () => {
    const response = await refusalOf({
      'sec-fetch-mode': 'navigate',
      referer: 'https://evil.example/x',
    });
    expect(response.headers.get('location')).toBe('/login');
  });

  it('a script’s request keeps the JSON answer', async () => {
    const response = await refusalOf({ 'sec-fetch-mode': 'cors', referer: page });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated', reason: 'no session' });
  });
});
