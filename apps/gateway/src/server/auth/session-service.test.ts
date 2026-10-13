import { describe, expect, it } from 'vitest';

import { MemorySessionStore } from '../compose/memory';
import { ManualClock } from '../store/clock';
import { clearCookie, readCookie, serializeCookie } from './cookies';
import { LOGIN_TTL_MS, SESSION_TTL_MS, SessionService } from './session-service';

function service() {
  const clock = new ManualClock();
  const store = new MemorySessionStore(() => clock.now().getTime());
  return { clock, service: new SessionService(store, clock) };
}

describe('cookies', () => {
  it('serializes HttpOnly, Secure, SameSite=Lax cookies and reads them back', () => {
    const header = serializeCookie('vbn_session', 'abc_-123', { maxAgeSeconds: 60 });
    expect(header).toBe('vbn_session=abc_-123; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
    expect(
      readCookie(new Headers({ cookie: `other=1; ${header.split(';')[0]}` }), 'vbn_session'),
    ).toBe('abc_-123');
    expect(clearCookie('vbn_session')).toContain('Max-Age=0');
  });
  it('ignores malformed cookie values and non-base64url ids', () => {
    expect(readCookie(new Headers({ cookie: 'vbn_session=a b' }), 'vbn_session')).toBeNull();
    expect(readCookie(new Headers({ cookie: 'vbn_session=%2F..' }), 'vbn_session')).toBeNull();
    expect(readCookie(new Headers(), 'vbn_session')).toBeNull();
    expect(() => serializeCookie('x', 'bad value', { maxAgeSeconds: 1 })).toThrow(RangeError);
  });
});

describe('SessionService', () => {
  it('creates a user session the cookie resolves, and destroys it', async () => {
    const { service: s } = service();
    const issued = await s.create({
      kind: 'user',
      userId: 'u1',
      login: { email: 'a@b', groups: [] },
    });
    expect(issued.setCookie).toMatch(
      /^vbn_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax$/,
    );
    const headers = new Headers({ cookie: issued.setCookie.split(';')[0] ?? '' });
    const read = await s.read(headers);
    expect(read?.record).toMatchObject({ kind: 'user', userId: 'u1' });
    const cleared = await s.destroy(headers);
    expect(cleared).toContain('vbn_session=;');
    expect(await s.read(headers)).toBeNull();
  });

  it('expires a session after SESSION_TTL_MS, absolutely (no sliding)', async () => {
    const { clock, service: s } = service();
    const issued = await s.create({ kind: 'bootstrap' });
    const headers = new Headers({ cookie: issued.setCookie.split(';')[0] ?? '' });
    clock.advance(SESSION_TTL_MS - 1);
    expect(await s.read(headers)).not.toBeNull();
    clock.advance(1);
    expect(await s.read(headers)).toBeNull();
  });

  it('keeps pending logins apart from sessions, single-use, with a short TTL', async () => {
    const { clock, service: s } = service();
    const pending = await s.createPending({
      state: 's',
      nonce: 'n',
      codeVerifier: 'v',
      returnTo: '/x',
    });
    expect(pending.setCookie).toContain(`vbn_login=`);
    expect(pending.setCookie).toContain(`Max-Age=${LOGIN_TTL_MS / 1000}`);
    const headers = new Headers({ cookie: pending.setCookie.split(';')[0] ?? '' });
    // the login cookie is not a session
    expect(await s.read(headers)).toBeNull();
    expect(await s.takePending(headers)).toMatchObject({ state: 's', nonce: 'n', returnTo: '/x' });
    expect(await s.takePending(headers)).toBeNull();

    const again = await s.createPending({
      state: 's2',
      nonce: 'n',
      codeVerifier: 'v',
      returnTo: '/',
    });
    clock.advance(LOGIN_TTL_MS);
    expect(
      await s.takePending(new Headers({ cookie: again.setCookie.split(';')[0] ?? '' })),
    ).toBeNull();
  });
});
