/**
 * Claim mapping (spec §4.3 "claim mapping (subject, email, groups)").
 *
 * Pure: takes the claims the IdP returned (ID token merged with userinfo) and
 * the configured claim names, produces the identity the store persists. The
 * groups claim is tolerated in the three shapes seen in the wild: an array of
 * strings (Keycloak, Okta, Entra ID), a delimited string (space, comma or
 * semicolon separated, some SAML bridges), or absent (Google, which has no
 * groups claim).
 */
import type { IdpClaimMapping } from '../config/types';
import { LoginError } from './errors';

export type RawClaims = Readonly<Record<string, unknown>>;

export interface IdentityClaims {
  /** Stable subject, as the IdP issued it. */
  readonly subject: string;
  /** Lower-cased. */
  readonly email: string;
  readonly displayName: string | null;
  /** Distinct, trimmed, in claim order. Empty when the IdP sends none. */
  readonly groups: readonly string[];
}

const GROUP_DELIMITERS = /[\s,;]+/;

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

export function mapClaims(raw: RawClaims, mapping: IdpClaimMapping): IdentityClaims {
  const subject = nonEmptyString(raw[mapping.sub]);
  const email = nonEmptyString(raw[mapping.email]);
  const missing = [subject === null ? mapping.sub : null, email === null ? mapping.email : null]
    .filter((c): c is string => c !== null)
    .map((c) => `'${c}'`);
  if (subject === null || email === null) {
    throw new LoginError(
      'claims-missing',
      `claim(s) ${missing.join(', ')} missing or empty; check idp.claims in the instance configuration`,
    );
  }
  return {
    subject,
    email: email.toLowerCase(),
    displayName: nonEmptyString(raw.name),
    groups: parseGroupsClaim(raw[mapping.groups]),
  };
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
