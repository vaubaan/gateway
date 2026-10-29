/**
 * Who may sign in (spec §0 "Open provider", "Invitation", §6 "human
 * authentication"; docs/handbook/authentication.md). Decided
 * after the provider vouched for the identity and before anything is written:
 * a refused sign-in creates no user, syncs no group and revokes no bootstrap
 * token.
 *
 * A sign-in is admitted when its email:
 *
 *   1. is verified — an explicit "unverified" is refused earlier (`mapClaims`);
 *      an open provider must say "verified" outright, since anyone can hold an
 *      account there and claim any address; so must a company directory set
 *      with `require_verified_email` (Entra ID: `xms_edov`);
 *   2. and is in a domain the provider allows, or is invited, or the store names
 *      the person an administrator — by their identity, a pending address, or a
 *      designated group of this provider that claims them (ADR
 *      administrators-live-in-the-instance);
 *   3. or the provider is a company directory with no allowed domain and not
 *      "invited only": everyone the directory authenticates.
 *
 * A provider has one of three admission rules: everyone of the directory (no
 * domain, not "invited only"; never an open provider), its domains (and the
 * invited addresses), or invited addresses only (no domain, "invited only").
 * "Invited only" with domains is refused when the provider is saved or loaded
 * (`admissionProblem`).
 *
 * Pure: the invitation lookup is passed in.
 */
import { admitsEveryone, isOpenProvider, type SignInProvider } from '../config/sign-in';
import type { IdentityClaims } from './claims';
import { LoginError } from './errors';

export interface AdmissionContext {
  /** Whether the address (lower-cased) is on the invitation list. */
  readonly isInvited: (email: string) => Promise<boolean>;
  /**
   * Whether the store names this identity an administrator, or will once signed in: a
   * user designation of its (issuer, subject), a pending address for this provider, or
   * a designated group this provider claims it a member of (`AdministratorsService.admits`).
   */
  readonly isAdministrator: () => Promise<boolean>;
}

export type AdmissionReason =
  'everyone-of-the-directory' | 'domain' | 'invitation' | 'administrator';

/** A company directory whose configuration asks for a verified email (`require_verified_email`). */
function requiresVerifiedEmail(provider: SignInProvider): boolean {
  return provider.kind === 'oidc' && provider.requireVerifiedEmail === true;
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

/** Why the sign-in is admitted; throws the `LoginError` of the refusal otherwise. */
export async function admit(
  identity: Pick<IdentityClaims, 'email' | 'emailVerified' | 'subject'>,
  provider: SignInProvider,
  context: AdmissionContext,
): Promise<AdmissionReason> {
  const email = identity.email.toLowerCase();
  if (isOpenProvider(provider) && identity.emailVerified !== true) {
    throw new LoginError(
      'email-not-verified',
      `provider '${provider.id}' is open to anyone and did not say it verified the email of subject '${identity.subject}'`,
    );
  }
  if (requiresVerifiedEmail(provider) && identity.emailVerified !== true) {
    throw new LoginError(
      'email-not-verified',
      `provider '${provider.id}' requires a verified email and did not say it verified the email of subject '${identity.subject}'`,
    );
  }
  if (admitsEveryone(provider)) return 'everyone-of-the-directory';
  if (provider.allowedEmailDomains.includes(domainOf(email))) return 'domain';
  if (await context.isInvited(email)) return 'invitation';
  if (await context.isAdministrator()) return 'administrator';
  if (provider.allowedEmailDomains.length === 0) {
    throw new LoginError(
      'not-invited',
      `'${email}' is not invited and provider '${provider.id}' admits invited addresses only`,
    );
  }
  throw new LoginError(
    'email-domain-not-allowed',
    `domain '${domainOf(email)}' is not allowed by provider '${provider.id}' and '${email}' is not invited`,
  );
}
