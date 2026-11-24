import { describe, expect, it } from 'vitest';

import { cookieJar, HOST_COOKIES, serializeCookie, SESSION_COOKIE } from './cookies';

describe('cookie jars', () => {
  it('host: __Host- names, Secure', () => {
    expect(HOST_COOKIES.name('vbn_session')).toBe(SESSION_COOKIE);
    const set = HOST_COOKIES.serialize('vbn_session', 'abc', { maxAgeSeconds: 60 });
    expect(set).toBe('__Host-vbn_session=abc; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
    expect(HOST_COOKIES.clear('vbn_login')).toContain('Secure');
  });

  it('loopback (local mode): plain names, no Secure, the rest kept', () => {
    const jar = cookieJar('loopback');
    const set = jar.serialize('vbn_session', 'abc', { maxAgeSeconds: 60 });
    expect(set).toBe('vbn_session=abc; Path=/; Max-Age=60; HttpOnly; SameSite=Lax');
    expect(jar.clear('vbn_recover')).toBe(
      'vbn_recover=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    );
    const headers = new Headers({ cookie: 'vbn_session=abc; __Host-vbn_session=other' });
    expect(jar.read(headers, 'vbn_session')).toBe('abc');
    expect(HOST_COOKIES.read(headers, 'vbn_session')).toBe('other');
  });

  it('never writes a __Host- cookie without Secure: the browser would drop it', () => {
    expect(() => serializeCookie(SESSION_COOKIE, 'abc', { maxAgeSeconds: 1 }, false)).toThrow(
      /must be Secure/,
    );
  });
});
