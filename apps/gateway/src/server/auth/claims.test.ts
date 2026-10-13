import { describe, expect, it } from 'vitest';

import { assertEmailDomainAllowed, mapClaims, parseGroupsClaim } from './claims';
import { LoginError } from './errors';

const MAPPING = { sub: 'sub', email: 'email', groups: 'groups' };
const ISS = 'https://idp.example.com';

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
      mapClaims(
        { iss: ISS, sub: 'idp|1', email: 'Ada@Example.COM', name: 'Ada', groups: ['dev'] },
        MAPPING,
      ),
    ).toEqual({
      issuer: ISS,
      subject: 'idp|1',
      email: 'ada@example.com',
      displayName: 'Ada',
      groups: ['dev'],
    });
  });
  it('honours a custom mapping (Entra ID style)', () => {
    const mapping = { sub: 'oid', email: 'preferred_username', groups: 'roles' };
    expect(
      mapClaims(
        { iss: ISS, oid: 'o-1', preferred_username: 'x@y.z', roles: 'a b', sub: 'ignored' },
        mapping,
      ),
    ).toEqual({
      issuer: ISS,
      subject: 'o-1',
      email: 'x@y.z',
      displayName: null,
      groups: ['a', 'b'],
    });
  });
  it('fails closed naming the missing claims', () => {
    expect(() => mapClaims({ iss: ISS, sub: 'x' }, MAPPING)).toThrowError(
      /claims-missing.*'email'/,
    );
    expect(() => mapClaims({ iss: ISS, email: 'x@y' }, MAPPING)).toThrowError(/'sub'/);
    expect(() => mapClaims({ iss: ISS, sub: '  ', email: '' }, MAPPING)).toThrowError(
      /'sub', 'email'/,
    );
    try {
      mapClaims({}, MAPPING);
    } catch (err) {
      expect(err).toBeInstanceOf(LoginError);
      expect((err as LoginError).code).toBe('claims-missing');
    }
  });

  it('requires the issuer: a user is (issuer, subject), and `iss` is not a mappable claim', () => {
    expect(() => mapClaims({ sub: 'x', email: 'x@y' }, MAPPING)).toThrowError(
      /claims-missing.*'iss'/,
    );
    expect(() => mapClaims({ iss: '  ', sub: 'x', email: 'x@y' }, MAPPING)).toThrowError(/'iss'/);
    // The subject may be read from another claim; the issuer never is.
    const mapping = { sub: 'oid', email: 'email', groups: 'groups' };
    expect(mapClaims({ iss: ISS, oid: 'o-1', email: 'x@y' }, mapping)).toMatchObject({
      issuer: ISS,
      subject: 'o-1',
    });
  });
});

describe('mapClaims when the userinfo request failed', () => {
  const idToken = { iss: ISS, sub: 'idp|1', email: 'ada@example.com' };
  const failed = { userinfoFailed: true };

  it('refuses when the groups are not in the ID token either: unknown is not "none"', () => {
    let thrown: unknown;
    try {
      mapClaims(idToken, MAPPING, failed);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LoginError);
    expect((thrown as LoginError).code).toBe('groups-unavailable');
    expect((thrown as LoginError).message).toContain("'groups'");
  });

  it('follows the configured groups claim', () => {
    const mapping = { sub: 'sub', email: 'email', groups: 'roles' };
    expect(() => mapClaims({ ...idToken, groups: ['dev'] }, mapping, failed)).toThrowError(
      /groups-unavailable.*'roles'/,
    );
    expect(mapClaims({ ...idToken, roles: ['dev'] }, mapping, failed).groups).toEqual(['dev']);
  });

  it('signs in when the ID token itself carries the groups, even an empty list', () => {
    expect(mapClaims({ ...idToken, groups: ['dev'] }, MAPPING, failed).groups).toEqual(['dev']);
    expect(mapClaims({ ...idToken, groups: [] }, MAPPING, failed).groups).toEqual([]);
  });

  it('a missing identity claim is reported first: it names what to configure', () => {
    expect(() => mapClaims({ iss: ISS, sub: 'x' }, MAPPING, failed)).toThrowError(/claims-missing/);
  });

  it('without a failure, an absent groups claim is an IdP that sends none', () => {
    expect(mapClaims(idToken, MAPPING).groups).toEqual([]);
    expect(mapClaims(idToken, MAPPING, { userinfoFailed: false }).groups).toEqual([]);
  });
});

describe('mapClaims and email_verified', () => {
  const claims = { iss: ISS, sub: 'idp|1', email: 'ops@example.com' };

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
      mapClaims(
        { iss: ISS, oid: 'o-1', preferred_username: 'x@y.z', email_verified: false },
        mapping,
      ),
    ).toThrowError(/email-not-verified/);
  });
});

describe('mapClaims and the group overage claim (Entra ID)', () => {
  const claims = { iss: ISS, sub: 'idp|1', email: 'ops@example.com' };
  const refusal = (raw: Record<string, unknown>, mapping = MAPPING): LoginError => {
    let thrown: unknown;
    try {
      mapClaims(raw, mapping);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LoginError);
    return thrown as LoginError;
  };

  it('refuses a token whose groups were moved out of it, instead of reading "no groups"', () => {
    // What Entra ID sends above 200 groups: no `groups` claim, a pointer to the Graph API.
    const overage = {
      ...claims,
      _claim_names: { groups: 'src1' },
      _claim_sources: {
        src1: { endpoint: 'https://graph.microsoft.com/v1.0/users/x/getMemberObjects' },
      },
    };
    const err = refusal(overage);
    expect(err.code).toBe('groups-overage');
    // Operator-facing: the log line names the claim and what to change at the IdP.
    expect(err.message).toContain("'groups'");
    expect(err.message).toMatch(/groups assigned to the application/i);
  });

  it('refuses the implicit-flow marker `hasgroups`, as a boolean or a string', () => {
    for (const marker of [true, 'true', 'True']) {
      expect(refusal({ ...claims, hasgroups: marker }).code, String(marker)).toBe('groups-overage');
    }
  });

  it('refuses even when a partial groups claim travels next to the pointer', () => {
    const err = refusal({ ...claims, groups: ['dev'], _claim_names: { groups: 'src1' } });
    expect(err.code).toBe('groups-overage');
  });

  it('follows the configured claim name: a pointer for another claim is not an overage', () => {
    const mapping = { sub: 'sub', email: 'email', groups: 'roles' };
    // The mapped claim is `roles`: `groups` being moved out does not concern it…
    expect(
      mapClaims(
        { ...claims, roles: ['admins'], _claim_names: { groups: 'src1' }, hasgroups: true },
        mapping,
      ).groups,
    ).toEqual(['admins']);
    // …and a pointer for `roles` itself does.
    expect(refusal({ ...claims, _claim_names: { roles: 'src1' } }, mapping).code).toBe(
      'groups-overage',
    );
  });

  it('accepts a token with no groups and no pointer (an IdP that sends none)', () => {
    expect(mapClaims(claims, MAPPING).groups).toEqual([]);
    expect(mapClaims({ ...claims, hasgroups: false }, MAPPING).groups).toEqual([]);
    expect(mapClaims({ ...claims, _claim_names: 'garbage' }, MAPPING).groups).toEqual([]);
    expect(mapClaims({ ...claims, _claim_names: { other: 'src1' } }, MAPPING).groups).toEqual([]);
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
