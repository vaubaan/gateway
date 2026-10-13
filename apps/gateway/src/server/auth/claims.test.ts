import { describe, expect, it } from 'vitest';

import { assertEmailDomainAllowed, mapClaims, parseGroupsClaim } from './claims';
import { LoginError } from './errors';

const MAPPING = { sub: 'sub', email: 'email', groups: 'groups' };

describe('parseGroupsClaim', () => {
  it('reads an array of strings, trimmed and de-duplicated', () => {
    expect(parseGroupsClaim(['dev', ' ops ', 'dev', 7, null])).toEqual(['dev', 'ops']);
  });
  it('splits a space, comma or semicolon delimited string', () => {
    expect(parseGroupsClaim('dev ops')).toEqual(['dev', 'ops']);
    expect(parseGroupsClaim('dev,ops; admins')).toEqual(['dev', 'ops', 'admins']);
  });
  it('yields no group when the claim is absent or of another type', () => {
    expect(parseGroupsClaim(undefined)).toEqual([]);
    expect(parseGroupsClaim({ dev: true })).toEqual([]);
    expect(parseGroupsClaim('')).toEqual([]);
  });
});

describe('mapClaims', () => {
  it('maps the default claim names and lower-cases the email', () => {
    expect(
      mapClaims({ sub: 'idp|1', email: 'Ada@Example.COM', name: 'Ada', groups: ['dev'] }, MAPPING),
    ).toEqual({ subject: 'idp|1', email: 'ada@example.com', displayName: 'Ada', groups: ['dev'] });
  });
  it('honours a custom mapping (Entra ID style)', () => {
    const mapping = { sub: 'oid', email: 'preferred_username', groups: 'roles' };
    expect(
      mapClaims({ oid: 'o-1', preferred_username: 'x@y.z', roles: 'a b', sub: 'ignored' }, mapping),
    ).toEqual({ subject: 'o-1', email: 'x@y.z', displayName: null, groups: ['a', 'b'] });
  });
  it('fails closed naming the missing claims', () => {
    expect(() => mapClaims({ sub: 'x' }, MAPPING)).toThrowError(/claims-missing.*'email'/);
    expect(() => mapClaims({ email: 'x@y' }, MAPPING)).toThrowError(/'sub'/);
    expect(() => mapClaims({ sub: '  ', email: '' }, MAPPING)).toThrowError(/'sub', 'email'/);
    try {
      mapClaims({}, MAPPING);
    } catch (err) {
      expect(err).toBeInstanceOf(LoginError);
      expect((err as LoginError).code).toBe('claims-missing');
    }
  });
});

describe('mapClaims and email_verified', () => {
  const claims = { sub: 'idp|1', email: 'ops@example.com' };

  it('refuses an email the IdP marks as unverified, with its own closed code', () => {
    for (const unverified of [false, 'false', 'False', 0]) {
      let thrown: unknown = null;
      try {
        mapClaims({ ...claims, email_verified: unverified }, MAPPING);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `email_verified=${String(unverified)}`).toBeInstanceOf(LoginError);
      expect(thrown instanceof LoginError && thrown.code).toBe('email-not-verified');
    }
  });

  it('accepts a verified email, and an IdP that does not send the claim at all', () => {
    expect(mapClaims({ ...claims, email_verified: true }, MAPPING).email).toBe('ops@example.com');
    expect(mapClaims({ ...claims, email_verified: 'true' }, MAPPING).email).toBe('ops@example.com');
    expect(mapClaims(claims, MAPPING).email).toBe('ops@example.com');
  });

  it('refuses the unverified flag whatever claim the email is mapped from', () => {
    const mapping = { sub: 'oid', email: 'preferred_username', groups: 'roles' };
    expect(() =>
      mapClaims({ oid: 'o-1', preferred_username: 'x@y.z', email_verified: false }, mapping),
    ).toThrowError(/email-not-verified/);
  });
});

describe('assertEmailDomainAllowed', () => {
  it('allows every domain when the list is empty', () => {
    expect(() => assertEmailDomainAllowed('a@anything.test', [])).not.toThrow();
  });
  it('compares the domain case-insensitively against the list', () => {
    expect(() => assertEmailDomainAllowed('a@Example.COM', ['example.com'])).not.toThrow();
    expect(() => assertEmailDomainAllowed('a@other.test', ['example.com'])).toThrowError(
      /email-domain-not-allowed/,
    );
    expect(() => assertEmailDomainAllowed('no-at-sign', ['example.com'])).toThrowError(LoginError);
  });
});
