/**
 * Who may sign in (spec §0 "Open provider", "Invitation", §6 "human
 * authentication"; ADR sign-in-providers-admission-and-admin-rule). Decided
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
 *   2. and is in a domain the provider allows, or is invited, or is one of the
 *      admin emails, or the admin rule's group is this provider's and the
 *      provider claimed the person a member of it (the configuration names
 *      those people; amendment of 2026-10-19 of the ADR);
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
import {
  admitsEveryone,
  isOpenProvider,
  type AdminGroup,
  type SignInProvider,
} from '../config/sign-in';
import type { IdentityClaims } from './claims';
import { LoginError } from './errors';

export interface AdmissionContext {
  /** Whether the address (lower-cased) is on the invitation list. */
  readonly isInvited: (email: string) => Promise<boolean>;
  /** The admin rule's emails, lower-cased. */
  readonly adminEmails: readonly string[];
  /** The admin rule's group, resolved to its provider; `null` when the rule has none. */
  readonly adminGroup: AdminGroup | null;
}

export type AdmissionReason =
  'everyone-of-the-directory' | 'domain' | 'invitation' | 'admin-email' | 'admin-group';

/** A company directory whose configuration asks for a verified email (`require_verified_email`). */
function requiresVerifiedEmail(provider: SignInProvider): boolean {
  return provider.kind === 'oidc' && provider.requireVerifiedEmail === true;
}

/**
 * The provider claimed the person a member of the admin rule's group — the
 * membership `isOperator` reads after the sync, so a group of another provider
 * named like it does not count.
 */
function isAdminGroupMember(
  groups: readonly string[],
  provider: SignInProvider,
  group: AdminGroup | null,
): boolean {
  return group !== null && group.provider === provider.id && groups.includes(group.name);
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

/** Why the sign-in is admitted; throws the `LoginError` of the refusal otherwise. */
export async function admit(
  identity: Pick<IdentityClaims, 'email' | 'emailVerified' | 'subject' | 'groups'>,
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
  if (context.adminEmails.includes(email)) return 'admin-email';
  if (isAdminGroupMember(identity.groups, provider, context.adminGroup)) return 'admin-group';
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
