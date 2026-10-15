import { describe, expect, it } from 'vitest';

import { MemorySessionStore } from '../compose/memory';
import { ManualClock } from '../store/clock';
import {
  clearCookie,
  HOST_PREFIX,
  LOGIN_COOKIE,
  readCookie,
  serializeCookie,
  SESSION_COOKIE,
} from './cookies';
import { LOGIN_TTL_MS, SESSION_IDLE_MS, SESSION_TTL_MS, SessionService } from './session-service';

function service() {
  const clock = new ManualClock();
  const store = new MemorySessionStore(() => clock.now().getTime());
  return { clock, store, service: new SessionService(store, clock) };
}

const SESSION_ID = 'A'.repeat(43);
const sessionCookie = (): Headers => new Headers({ cookie: `__Host-vbn_session=${SESSION_ID}` });
const loginCookie = (): Headers => new Headers({ cookie: `__Host-vbn_login=${SESSION_ID}` });

describe('cookies', () => {
  it('serializes HttpOnly, Secure, SameSite=Lax cookies and reads them back', () => {
    const header = serializeCookie('__Host-vbn_session', 'abc_-123', { maxAgeSeconds: 60 });
    expect(header).toBe(
      '__Host-vbn_session=abc_-123; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax',
    );
    expect(
      readCookie(new Headers({ cookie: `other=1; ${header.split(';')[0]}` }), '__Host-vbn_session'),
    ).toBe('abc_-123');
    expect(clearCookie('__Host-vbn_session')).toContain('Max-Age=0');
  });
  it('ignores malformed cookie values and non-base64url ids', () => {
    expect(
      readCookie(new Headers({ cookie: '__Host-vbn_session=a b' }), '__Host-vbn_session'),
    ).toBeNull();
    expect(
      readCookie(new Headers({ cookie: '__Host-vbn_session=%2F..' }), '__Host-vbn_session'),
    ).toBeNull();
    expect(readCookie(new Headers(), '__Host-vbn_session')).toBeNull();
    expect(() => serializeCookie('x', 'bad value', { maxAgeSeconds: 1 })).toThrow(RangeError);
  });
  it('names both cookies with the __Host- prefix and keeps what the prefix requires', () => {
    // RFC 6265bis §4.1.3.2: Secure, Path=/, no Domain attribute — or the browser drops it.
    for (const name of [SESSION_COOKIE, LOGIN_COOKIE]) {
      expect(name.startsWith(HOST_PREFIX)).toBe(true);
      for (const header of [
        serializeCookie(name, 'abc', { maxAgeSeconds: 60 }),
        clearCookie(name),
      ]) {
        const attributes = header.split('; ').slice(1);
        expect(attributes).toContain('Secure');
        expect(attributes).toContain('Path=/');
        expect(attributes.some((a) => a.toLowerCase().startsWith('domain'))).toBe(false);
      }
    }
  });
  it('matches the cookie name exactly: a look-alike name a sibling subdomain can set is not the session', () => {
    // A browser enforces the __Host- rules on the literal name. `\u00a0__Host-…` is
    // another name to it — settable with Domain=<parent>, without Secure — and must be
    // another name here too (`String.prototype.trim` would have made them equal).
    const planted = 'PLANTED';
    for (const lookalike of [
      `\u00a0${SESSION_COOKIE}`,
      // U+2003 and U+FEFF as the bytes a server receives (UTF-8, read as latin1).
      `\u00e2\u0080\u0083${SESSION_COOKIE}`,
      `\u00ef\u00bb\u00bf${SESSION_COOKIE}`,
      `\u000b${SESSION_COOKIE}`,
      `\u000c${SESSION_COOKIE}`,
      `${SESSION_COOKIE}\u00a0`,
      `${SESSION_COOKIE} `,
      `${SESSION_COOKIE}\t`,
    ]) {
      const headers = new Headers({ cookie: `other=1; ${lookalike}=${planted}` });
      expect(readCookie(headers, SESSION_COOKIE), JSON.stringify(lookalike)).toBeNull();
    }
    // The separator's own space and tab are not part of the name.
    expect(
      readCookie(new Headers({ cookie: `a=1;  \t${SESSION_COOKIE}=abc` }), SESSION_COOKIE),
    ).toBe('abc');
    expect(readCookie(new Headers({ cookie: `${SESSION_COOKIE}=abc` }), SESSION_COOKIE)).toBe(
      'abc',
    );
  });

  it('reads no session when the name appears twice: which one the browser meant cannot be told', () => {
    const twice = new Headers({ cookie: `${SESSION_COOKIE}=first; x=1; ${SESSION_COOKIE}=second` });
    expect(readCookie(twice, SESSION_COOKIE)).toBeNull();
    // Another cookie twice does not matter.
    const other = new Headers({ cookie: `x=1; x=2; ${SESSION_COOKIE}=abc` });
    expect(readCookie(other, SESSION_COOKIE)).toBe('abc');
  });

  it('refuses to write a __Host- cookie on another path', () => {
    expect(() =>
      serializeCookie(SESSION_COOKIE, 'abc', { maxAgeSeconds: 1, path: '/admin' }),
    ).toThrow(RangeError);
    expect(() => clearCookie(LOGIN_COOKIE, '/auth')).toThrow(RangeError);
    // An unprefixed cookie keeps its freedom of path.
    expect(serializeCookie('other', 'abc', { maxAgeSeconds: 1, path: '/x' })).toContain('Path=/x');
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
      /^__Host-vbn_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax$/,
    );
    const headers = new Headers({ cookie: issued.setCookie.split(';')[0] ?? '' });
    const read = await s.read(headers);
    expect(read?.record).toMatchObject({ kind: 'user', userId: 'u1' });
    const cleared = await s.destroy(headers);
    expect(cleared).toContain('__Host-vbn_session=;');
    expect(await s.read(headers)).toBeNull();
  });

  it('expires a session after SESSION_TTL_MS, absolutely (use does not slide it)', async () => {
    const { clock, service: s } = service();
    const issued = await s.create({ kind: 'bootstrap' });
    const headers = new Headers({ cookie: issued.setCookie.split(';')[0] ?? '' });
    const step = SESSION_IDLE_MS / 2;
    for (let used = step; used < SESSION_TTL_MS; used += step) {
      clock.advance(step);
      expect(await s.read(headers), `after ${used} ms`).not.toBeNull();
    }
    clock.advance(SESSION_TTL_MS % step || step);
    expect(await s.read(headers)).toBeNull();
  });

  it('ends a session unused for SESSION_IDLE_MS; a request within it keeps it', async () => {
    const { clock, service: s } = service();
    const issued = await s.create({ kind: 'bootstrap' });
    const headers = new Headers({ cookie: issued.setCookie.split(';')[0] ?? '' });
    clock.advance(SESSION_IDLE_MS - 1);
    expect(await s.read(headers)).not.toBeNull();
    clock.advance(SESSION_IDLE_MS - 1);
    expect(await s.read(headers)).not.toBeNull();
    clock.advance(SESSION_IDLE_MS);
    expect(await s.read(headers)).toBeNull();
    // Gone for good: a later request does not bring it back.
    expect(await s.read(headers)).toBeNull();
  });

  it('keeps pending logins apart from sessions, single-use, with a short TTL', async () => {
    const { clock, service: s } = service();
    const pending = await s.createPending({
      providerId: 'idp',
      state: 's',
      nonce: 'n',
      codeVerifier: 'v',
      returnTo: '/x',
    });
    expect(pending.setCookie).toContain(`__Host-vbn_login=`);
    expect(pending.setCookie).toContain(`Max-Age=${LOGIN_TTL_MS / 1000}`);
    const headers = new Headers({ cookie: pending.setCookie.split(';')[0] ?? '' });
    // the login cookie is not a session
    expect(await s.read(headers)).toBeNull();
    expect(await s.takePending(headers)).toMatchObject({ state: 's', nonce: 'n', returnTo: '/x' });
    expect(await s.takePending(headers)).toBeNull();

    const again = await s.createPending({
      providerId: 'idp',
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

  it('reads a stored record of another shape as no session, and deletes it', async () => {
    const malformed: unknown[] = [
      'a string',
      42,
      [],
      {},
      { kind: 'operator', createdAt: '2026-01-01T00:00:00.000Z' },
      { kind: 'bootstrap' },
      { kind: 'user', createdAt: '2026-01-01T00:00:00.000Z', login: { email: 'a@b', groups: [] } },
      { kind: 'user', userId: 7, createdAt: 'x', login: { email: 'a@b', groups: [] } },
      { kind: 'user', userId: 'u1', createdAt: 'x', login: { email: 'a@b', groups: [1] } },
      { kind: 'user', userId: 'u1', createdAt: 'x' },
    ];
    for (const value of malformed) {
      const { store, service: s } = service();
      await store.set(`session:${SESSION_ID}`, value, 60_000);
      expect(await s.read(sessionCookie()), JSON.stringify(value)).toBeNull();
      expect(await store.get(`session:${SESSION_ID}`), JSON.stringify(value)).toBeNull();
    }
  });

  it('reads a stored pending sign-in of another shape as none, and deletes it', async () => {
    const malformed: unknown[] = [
      null,
      'x',
      { state: 's', nonce: 'n', codeVerifier: 'v', createdAt: 'x' },
      { state: 's', nonce: 'n', codeVerifier: 7, returnTo: '/', createdAt: 'x' },
      { kind: 'bootstrap', createdAt: 'x' },
    ];
    for (const value of malformed) {
      const { store, service: s } = service();
      await store.set(`login:${SESSION_ID}`, value, 60_000);
      expect(await s.takePending(loginCookie()), JSON.stringify(value)).toBeNull();
      expect(await store.get(`login:${SESSION_ID}`), JSON.stringify(value)).toBeNull();
    }
  });
});
