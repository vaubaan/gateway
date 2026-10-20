/**
 * Claim mapping (spec §4.3 "claim mapping (subject, email, groups)").
 *
 * Pure: takes the claims the IdP returned (ID token merged with userinfo) and
 * the configured claim names, produces the identity the store persists. The
 * groups claim is tolerated in the three shapes seen in the wild: an array of
 * strings (Keycloak, Okta, Entra ID), a delimited string (space, comma or
 * semicolon separated, some SAML bridges), or absent (Google, which has no
 * groups claim).
 *
 * An email the IdP itself marks as unverified (`email_verified: false`) is
 * refused: the address decides the admin rule and the domain filter, so it
 * must not rest on a claim the IdP calls unproven. An absent claim is
 * accepted (many IdPs never send it).
 *
 * **Group overage.** Entra ID leaves the groups out of a token once the user
 * belongs to too many of them (200 in a JWT) and sends a pointer instead:
 * `_claim_names` naming the claim (OpenID Connect Core §5.6.2, distributed
 * claims), or `hasgroups: true` in the implicit flow. Reading that as "no
 * groups" would silently strip the user of every group they hold — ownership
 * of the connections their groups own, the shares made to them, the admin rule
 * — and orphan their missions. The instance does not follow the pointer (it
 * would need a Graph API permission of its own), so the sign-in is refused
 * with a message for the operator; nothing is written.
 */
import type { IdpClaimMapping } from '../config/types';
import { LoginError } from './errors';

export type RawClaims = Readonly<Record<string, unknown>>;

export interface IdentityClaims {
  /**
   * The `iss` of the validated ID token, as issued. With `subject` it IS the
   * user: a subject is unique within its issuer only (OpenID Connect Core §2).
   */
  readonly issuer: string;
  /** Stable subject, as the IdP issued it. */
  readonly subject: string;
  /** Lower-cased. */
  readonly email: string;
  /**
   * Whether the provider says it verified the email: `true` when it says so, `null`
   * when it says nothing (many company directories never send the claim). An
   * explicit `false` never gets this far (`email-not-verified`). An open provider is
   * admitted on `true` only (`admission.ts`).
   */
  readonly emailVerified: true | null;
  readonly displayName: string | null;
  /** Distinct, trimmed, in claim order. Empty when the IdP sends none. */
  readonly groups: readonly string[];
  /**
   * The authentication methods the ID token names (`amr`, RFC 8176), when it names
   * any: `mfa` says the provider asked a second factor. Absent: it says nothing.
   */
  readonly amr?: readonly string[];
}

const GROUP_DELIMITERS = /[\s,;]+/;
/** The issuer claim of an ID token (OpenID Connect Core §2). */
const ISSUER_CLAIM = 'iss';
/** The standard OIDC claim about the `email` claim (OpenID Connect Core §5.1). */
const EMAIL_VERIFIED_CLAIM = 'email_verified';

/** Distributed-claims pointer (OpenID Connect Core §5.6.2): claim name → source. */
const CLAIM_NAMES_CLAIM = '_claim_names';
/** Entra ID's own name for its groups claim, and its implicit-flow overage marker. */
const ENTRA_GROUPS_CLAIM = 'groups';
const ENTRA_HAS_GROUPS_CLAIM = 'hasgroups';

function saysTrue(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

/**
 * True when the IdP says the groups exist but are not in the token. Judged on
 * the configured claim name; a partial list next to the pointer does not
 * count as the list.
 */
export function groupsMovedOutOfToken(raw: RawClaims, groupsClaim: string): boolean {
  const names = raw[CLAIM_NAMES_CLAIM];
  if (typeof names === 'object' && names !== null && !Array.isArray(names)) {
    if (Object.hasOwn(names, groupsClaim)) return true;
  }
  return groupsClaim === ENTRA_GROUPS_CLAIM && saysTrue(raw[ENTRA_HAS_GROUPS_CLAIM]);
}

/** True for an explicit negative, in the boolean form or the string form some IdPs send. */
function saysUnverified(value: unknown): boolean {
  if (value === false || value === 0) return true;
  return typeof value === 'string' && value.trim().toLowerCase() === 'false';
}

/** Reads the groups claim in any of its shapes; never throws. */
export function parseGroupsClaim(value: unknown): string[] {
  const candidates: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(GROUP_DELIMITERS)
      : [];
  const out: string[] = [];
  for (const entry of candidates) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name.length > 0 && !out.includes(name)) out.push(name);
  }
  return out;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Where the claims came from, when it changes what their absence means. */
export interface ClaimsProvenance {
  /**
   * The IdP has a userinfo endpoint and the request to it failed: `raw` is the
   * ID token alone. A claim absent from it may have been in the answer that
   * never came.
   */
  readonly userinfoFailed: boolean;
}

export function mapClaims(
  raw: RawClaims,
  mapping: IdpClaimMapping,
  provenance: ClaimsProvenance = { userinfoFailed: false },
): IdentityClaims {
  // `iss` is not configurable: it is the claim the ID token was validated on.
  const issuer = nonEmptyString(raw[ISSUER_CLAIM]);
  const subject = nonEmptyString(raw[mapping.sub]);
  const email = nonEmptyString(raw[mapping.email]);
  const missing = [
    issuer === null ? ISSUER_CLAIM : null,
    subject === null ? mapping.sub : null,
    email === null ? mapping.email : null,
  ]
    .filter((c): c is string => c !== null)
    .map((c) => `'${c}'`);
  if (issuer === null || subject === null || email === null) {
    throw new LoginError(
      'claims-missing',
      `claim(s) ${missing.join(', ')} missing or empty; check idp.claims in the instance configuration`,
    );
  }
  // The groups are not in the ID token, and the userinfo answer that may have carried
  // them never came: they are unknown, not empty. Syncing "no groups" would take the
  // user out of every IdP group for the length of the session — ownership of the
  // connections those groups own, the shares made to them, the admin rule.
  if (provenance.userinfoFailed && raw[mapping.groups] === undefined) {
    throw new LoginError(
      'groups-unavailable',
      `the ID token of subject '${subject}' carries no '${mapping.groups}' claim and the userinfo request failed, ` +
        'so the groups of this user are unknown; the sign-in is refused rather than read as "no groups"',
    );
  }
  const verifiedClaim = mapping.emailVerified ?? EMAIL_VERIFIED_CLAIM;
  if (saysUnverified(raw[verifiedClaim])) {
    throw new LoginError(
      'email-not-verified',
      `the identity provider marks the email of subject '${subject}' as unverified ('${verifiedClaim}' is false)`,
    );
  }
  if (groupsMovedOutOfToken(raw, mapping.groups)) {
    throw new LoginError(
      'groups-overage',
      `the identity provider left the '${mapping.groups}' claim of subject '${subject}' out of the token ` +
        `(group overage: '${CLAIM_NAMES_CLAIM}' or '${ENTRA_HAS_GROUPS_CLAIM}' points elsewhere) and this instance does not fetch it; ` +
        'the sign-in is refused rather than read as "no groups". At the identity provider, limit the groups claim ' +
        'to the groups assigned to the application (Entra ID: Token configuration → groups claim → ' +
        '"Groups assigned to the application"), or map idp.claims.groups to a claim that is always complete',
    );
  }
  return {
    issuer,
    subject,
    email: email.toLowerCase(),
    emailVerified: saysTrue(raw[verifiedClaim]) ? true : null,
    displayName: nonEmptyString(raw.name),
    groups: parseGroupsClaim(raw[mapping.groups]),
    ...amrOf(raw.amr),
  };
}

/** The `amr` claim as a list of method names, or nothing when it is not one. */
function amrOf(value: unknown): { readonly amr?: readonly string[] } {
  if (!Array.isArray(value)) return {};
  const methods = value.filter((m): m is string => typeof m === 'string' && m.length > 0);
  return methods.length > 0 ? { amr: methods } : {};
}

/** Spec §4.3 optional allowed-domain filter; an empty list allows every domain. */
export function assertEmailDomainAllowed(email: string, allowedDomains: readonly string[]): void {
  if (allowedDomains.length === 0) return;
  const at = email.lastIndexOf('@');
  const domain = at >= 0 ? email.slice(at + 1).toLowerCase() : '';
  if (!allowedDomains.includes(domain)) {
    throw new LoginError(
      'email-domain-not-allowed',
      `domain '${domain}' is not in idp.allowed_email_domains`,
    );
  }
}
