/**
 * `require_verified_email` and `claims.email_verified` (security review
 * 2026-10-15, auth M3): an admin rule by email on a company directory whose
 * `email` claim is not verified (Entra ID) can ask for the provider's own
 * verification signal (`xms_edov`).
 */
import { describe, expect, it } from 'vitest';

import { loadInstanceConfig } from '../config';
import { ConfigError } from '../config/errors';
import type { OidcSignInProvider } from '../config/sign-in';
import { validEnv } from '../config/testing';
import { admit } from './admission';
import { mapClaims } from './claims';
import { LoginError } from './errors';

const ENTRA = 'https://login.microsoftonline.com/44cd911b-0000-4000-8000-000000000000/v2.0';

function entra(rest: Partial<OidcSignInProvider> = {}): OidcSignInProvider {
  return {
    kind: 'oidc',
    id: 'entra',
    name: 'Entra',
    issuer: new URL(ENTRA),
    clientId: 'c',
    clientSecret: 's',
    claims: { sub: 'sub', email: 'email', groups: 'groups', emailVerified: 'xms_edov' },
    allowedEmailDomains: [],
    invitationOnly: true,
    ...rest,
  };
}

const admins = { isInvited: async () => false, adminEmails: ['boss@acme.example'] };

async function codeOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (err) {
    if (err instanceof LoginError) return err.code;
    throw err;
  }
}

describe('a verified email for a company directory', () => {
  it('reads the configured verification claim', () => {
    const mapping = entra().claims;
    const base = { iss: ENTRA, sub: 'x', email: 'Boss@acme.example' };
    expect(mapClaims({ ...base, xms_edov: true }, mapping).emailVerified).toBe(true);
    expect(mapClaims(base, mapping).emailVerified).toBeNull();
    // `email_verified` means nothing to this provider's mapping.
    expect(mapClaims({ ...base, email_verified: true }, mapping).emailVerified).toBeNull();
    expect(() => mapClaims({ ...base, xms_edov: false }, mapping)).toThrow(LoginError);
  });

  it('without the option, a directory admits the admin email on its word (unchanged)', async () => {
    const identity = { email: 'boss@acme.example', emailVerified: null, subject: 'x' } as const;
    expect(await admit(identity, entra(), admins)).toBe('admin-email');
  });

  it('with the option, an unverified admin email is refused; a verified one is admitted', async () => {
    const provider = entra({ requireVerifiedEmail: true });
    const unverified = { email: 'boss@acme.example', emailVerified: null, subject: 'x' } as const;
    expect(await codeOf(admit(unverified, provider, admins))).toBe('email-not-verified');
    const verified = { ...unverified, emailVerified: true } as const;
    expect(await admit(verified, provider, admins)).toBe('admin-email');
  });

  it('is read from the environment, and refused on a GitHub provider', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({
        VAUBAAN_SIGN_IN_ENTRA_KIND: 'oidc',
        VAUBAAN_SIGN_IN_ENTRA_ISSUER: ENTRA,
        VAUBAAN_SIGN_IN_ENTRA_CLIENT_ID: 'c',
        VAUBAAN_SIGN_IN_ENTRA_CLIENT_SECRET: 's',
        VAUBAAN_SIGN_IN_ENTRA_INVITATION_ONLY: 'true',
        VAUBAAN_SIGN_IN_ENTRA_CLAIM_EMAIL_VERIFIED: 'xms_edov',
        VAUBAAN_SIGN_IN_ENTRA_REQUIRE_VERIFIED_EMAIL: 'true',
      }),
    });
    const provider = config.signIn.find((p) => p.id === 'entra');
    expect(provider?.kind).toBe('oidc');
    if (provider?.kind !== 'oidc') return;
    expect(provider.requireVerifiedEmail).toBe(true);
    expect(provider.claims.emailVerified).toBe('xms_edov');

    expect(() =>
      loadInstanceConfig({
        env: validEnv({
          VAUBAAN_SIGN_IN_GITHUB_KIND: 'github',
          VAUBAAN_SIGN_IN_GITHUB_CLIENT_ID: 'c',
          VAUBAAN_SIGN_IN_GITHUB_CLIENT_SECRET: 's',
          VAUBAAN_SIGN_IN_GITHUB_INVITATION_ONLY: 'true',
          VAUBAAN_SIGN_IN_GITHUB_REQUIRE_VERIFIED_EMAIL: 'true',
        }),
      }),
    ).toThrow(ConfigError);
  });

  it('defaults: email_verified, not required', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({
        VAUBAAN_SIGN_IN_KC_KIND: 'oidc',
        VAUBAAN_SIGN_IN_KC_ISSUER: 'https://kc.example.com/realms/acme',
        VAUBAAN_SIGN_IN_KC_CLIENT_ID: 'c',
        VAUBAAN_SIGN_IN_KC_CLIENT_SECRET: 's',
      }),
    });
    const provider = config.signIn.find((p) => p.id === 'kc');
    if (provider?.kind !== 'oidc') throw new Error('expected an oidc provider');
    expect(provider.requireVerifiedEmail).toBe(false);
    expect(provider.claims.emailVerified).toBe('email_verified');
  });
});
