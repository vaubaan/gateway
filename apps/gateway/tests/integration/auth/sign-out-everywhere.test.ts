/**
 * "Sign out everywhere" (security review 2026-10-15, auth L1): every web session of
 * a user ends, by the user or by an operator; keys and status are untouched.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { memoryStoreDeps } from '../../../src/server/compose/testing';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';

const PUBLIC_URL = 'https://gateway.example.com';

function cookieOf(setCookie: string): Headers {
  return new Headers({ cookie: setCookie.split(';')[0] ?? '' });
}

describe('sign out everywhere', () => {
  let root: GatewayRoot;
  afterEach(async () => {
    await root.close();
  });

  async function open(): Promise<{ userId: string; first: Headers; second: Headers }> {
    root = await buildRoot({
      loadConfig: () => loadInstanceConfig({ env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL }) }),
      logWrite: () => undefined,
      ...memoryStoreDeps,
    });
    const user = await root.store.users.upsertFromIdp({
      issuer: 'https://idp.example.com',
      subject: 'ada',
      email: 'ada@example.com',
    });
    const login = { email: user.email, groups: [] };
    const first = await root.auth.sessions.create({ kind: 'user', userId: user.id, login });
    const second = await root.auth.sessions.create({ kind: 'user', userId: user.id, login });
    return {
      userId: user.id,
      first: cookieOf(first.setCookie),
      second: cookieOf(second.setCookie),
    };
  }

  it('the user ends every session of theirs, the one they used included', async () => {
    const { userId, first, second } = await open();
    expect(await root.auth.authenticator.authenticate(second)).not.toBeNull();
    const headers = new Headers(first);
    headers.set('origin', PUBLIC_URL);
    headers.set('content-type', 'application/x-www-form-urlencoded');
    const res = await root.users.handlers.signOutEverywhere(
      new Request(`${PUBLIC_URL}/logout/everywhere`, { method: 'POST', headers, body: '' }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
    expect(await root.auth.authenticator.authenticate(first)).toBeNull();
    expect(await root.auth.authenticator.authenticate(second)).toBeNull();
    expect((await root.store.users.getById(userId))?.status).toBe('active');
    const entries = await root.store.audit.list({ kind: 'admin', act: 'user-sessions-ended' });
    expect(entries).toHaveLength(1);
  });

  it('refuses a request from another origin', async () => {
    const { first } = await open();
    const headers = new Headers(first);
    headers.set('origin', 'https://evil.example');
    const res = await root.users.handlers.signOutEverywhere(
      new Request(`${PUBLIC_URL}/logout/everywhere`, { method: 'POST', headers, body: '' }),
    );
    expect(res.status).toBe(403);
    expect(await root.auth.authenticator.authenticate(first)).not.toBeNull();
  });

  it('a session opened afterwards works', async () => {
    const { userId } = await open();
    await root.users.service.endSessions({ actorId: userId, userId }, userId);
    // Sessions compare by instant: one opened later is after `sessions_ended_at`.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = await root.auth.sessions.create({
      kind: 'user',
      userId,
      login: { email: 'ada@example.com', groups: [] },
    });
    expect(await root.auth.authenticator.authenticate(cookieOf(later.setCookie))).not.toBeNull();
  });
});
