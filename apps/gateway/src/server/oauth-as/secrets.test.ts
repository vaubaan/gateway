import { describe, expect, it } from 'vitest';

import { prefixOfBearer } from '../missions/token';
import {
  ACCESS_TOKEN_PREFIX,
  CLIENT_ID_PREFIX,
  CLIENT_SECRET_PREFIX,
  digestOf,
  isAccessTokenShaped,
  isAuthorizationCodeShaped,
  isRefreshTokenShaped,
  matchesDigest,
  mintAccessToken,
  mintAuthorizationCode,
  mintClientId,
  mintClientSecret,
  mintRefreshToken,
  REFRESH_TOKEN_PREFIX,
} from './secrets';

describe('secrets of the authorization server', () => {
  it('mints 256-bit secrets under a prefix that names their kind', () => {
    expect(mintAccessToken()).toMatch(new RegExp(`^${ACCESS_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(mintRefreshToken()).toMatch(new RegExp(`^${REFRESH_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(mintClientSecret()).toMatch(new RegExp(`^${CLIENT_SECRET_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(mintAuthorizationCode()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintClientId()).toMatch(new RegExp(`^${CLIENT_ID_PREFIX}[A-Za-z0-9_-]{22}$`));
  });

  it('never mints the same secret twice', () => {
    const minted = new Set(Array.from({ length: 200 }, () => mintAccessToken()));
    expect(minted.size).toBe(200);
  });

  it('tells the kinds apart by shape, so one is never looked up as another', () => {
    const access = mintAccessToken();
    const refresh = mintRefreshToken();
    const code = mintAuthorizationCode();
    expect(isAccessTokenShaped(access)).toBe(true);
    expect(isAccessTokenShaped(refresh)).toBe(false);
    expect(isAccessTokenShaped(code)).toBe(false);
    expect(isRefreshTokenShaped(refresh)).toBe(true);
    expect(isRefreshTokenShaped(access)).toBe(false);
    expect(isAuthorizationCodeShaped(code)).toBe(true);
    expect(isAuthorizationCodeShaped(access)).toBe(false);
    expect(isAccessTokenShaped(`${access}x`)).toBe(false);
    expect(isAccessTokenShaped(` ${access}`)).toBe(false);
  });

  it('is never mistaken for a mission token', () => {
    for (const secret of [mintAccessToken(), mintRefreshToken(), mintClientSecret()]) {
      expect(prefixOfBearer(secret)).toBeNull();
    }
  });

  it('stores a SHA-256 digest, never the secret', () => {
    const token = mintAccessToken();
    const digest = digestOf(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token.slice(ACCESS_TOKEN_PREFIX.length));
    expect(digestOf(token)).toBe(digest);
  });

  it('matches a secret against its digest only', () => {
    const secret = mintClientSecret();
    expect(matchesDigest(secret, digestOf(secret))).toBe(true);
    expect(matchesDigest(`${secret}x`, digestOf(secret))).toBe(false);
    expect(matchesDigest('', digestOf(secret))).toBe(false);
    // A stored value that is not a digest matches nothing.
    expect(matchesDigest(secret, secret)).toBe(false);
    expect(matchesDigest(secret, '')).toBe(false);
  });
});
