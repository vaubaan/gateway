import { describe, expect, it } from 'vitest';

import type { SignInProvider } from '../config/sign-in';
import { admit } from './admission';
import { LoginError } from './errors';

function oidc(issuer: string, rest: Partial<SignInProvider> = {}): SignInProvider {
  return {
    kind: 'oidc',
    id: 'p',
    name: 'P',
    issuer: new URL(issuer),
    clientId: 'c',
    clientSecret: 's',
    claims: { sub: 'sub', email: 'email', groups: 'groups' },
    allowedEmailDomains: [],
    invitationOnly: false,
    ...rest,
  };
}

const GOOGLE = 'https://accounts.google.com';
const DIRECTORY = 'https://kc.example.com/realms/acme';
const nobodyInvited = { isInvited: async () => false, adminEmails: [] as string[] };

async function code(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof LoginError) return err.code;
    throw err;
  }
}

const who = (email: string, emailVerified: true | null = true) => ({
  email,
  emailVerified,
  subject: 's',
});

describe('admission', () => {
  it('a company directory without domains admits everyone it signs in, verified claim or not', async () => {
    expect(await admit(who('a@any.example', null), oidc(DIRECTORY), nobodyInvited)).toBe(
      'everyone-of-the-directory',
    );
  });

  it('domains admit their addresses, and invitations and admin emails the others', async () => {
    const p = oidc(DIRECTORY, { allowedEmailDomains: ['example.com'] });
    expect(await admit(who('a@Example.com'), p, nobodyInvited)).toBe('domain');
    expect(await code(admit(who('a@other.example'), p, nobodyInvited))).toBe(
      'email-domain-not-allowed',
    );
    expect(
      await admit(who('a@other.example'), p, { isInvited: async () => true, adminEmails: [] }),
    ).toBe('invitation');
    expect(
      await admit(who('ops@other.example'), p, {
        isInvited: async () => false,
        adminEmails: ['ops@other.example'],
      }),
    ).toBe('admin-email');
  });

  it('invitation only admits invited addresses only', async () => {
    const p = oidc(DIRECTORY, { invitationOnly: true });
    expect(await code(admit(who('a@example.com'), p, nobodyInvited))).toBe('not-invited');
    expect(
      await admit(who('a@example.com'), p, { isInvited: async () => true, adminEmails: [] }),
    ).toBe('invitation');
  });

  it('an open provider never admits an email it did not say it verified, invited or admin alike', async () => {
    const p = oidc(GOOGLE, { invitationOnly: true });
    const everything = { isInvited: async () => true, adminEmails: ['ops@example.com'] };
    expect(await code(admit(who('ops@example.com', null), p, everything))).toBe(
      'email-not-verified',
    );
    expect(await admit(who('ops@example.com', true), p, everything)).toBe('invitation');
  });

  it('an open provider without a rule would admit nobody but invited people and admins', async () => {
    // Such a provider is refused at load and save; admission still fails closed.
    const p = oidc(GOOGLE);
    expect(await code(admit(who('x@gmail.example'), p, nobodyInvited))).toBe('not-invited');
  });
});
