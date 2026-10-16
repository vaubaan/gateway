import { describe, expect, it } from 'vitest';

import { challengeOf, isCodeChallenge, isCodeVerifier, verifyS256 } from './pkce';

// RFC 7636 appendix B.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('PKCE, S256 only', () => {
  it('computes the challenge of the RFC 7636 example', () => {
    expect(challengeOf(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it('accepts the verifier behind the challenge', () => {
    expect(verifyS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
  });

  it('refuses another verifier, even one character away', () => {
    expect(verifyS256(`${RFC_VERIFIER.slice(0, -1)}l`, RFC_CHALLENGE)).toBe(false);
    expect(verifyS256('a'.repeat(43), RFC_CHALLENGE)).toBe(false);
  });

  it('refuses the challenge presented as its own verifier (the plain method)', () => {
    expect(verifyS256(RFC_CHALLENGE, RFC_CHALLENGE)).toBe(false);
  });

  it.each([
    ['too short', 'a'.repeat(42)],
    ['too long', 'a'.repeat(129)],
    ['a character outside the unreserved set', `${'a'.repeat(42)}+`],
    ['empty', ''],
  ])('refuses a verifier that is %s', (_case, verifier) => {
    expect(isCodeVerifier(verifier)).toBe(false);
    expect(verifyS256(verifier, challengeOf(verifier))).toBe(false);
  });

  it('accepts verifiers of 43 to 128 unreserved characters', () => {
    for (const verifier of ['a'.repeat(43), `${'A1-._~'.repeat(21)}ab`]) {
      expect(isCodeVerifier(verifier)).toBe(true);
      expect(verifyS256(verifier, challengeOf(verifier))).toBe(true);
    }
  });

  it.each([
    ['42 characters', 'a'.repeat(42)],
    ['44 characters', 'a'.repeat(44)],
    ['padded base64', `${'a'.repeat(42)}=`],
    ['standard base64 alphabet', `${'a'.repeat(42)}/`],
  ])('refuses a challenge of %s', (_case, challenge) => {
    expect(isCodeChallenge(challenge)).toBe(false);
    expect(verifyS256(RFC_VERIFIER, challenge)).toBe(false);
  });
});
