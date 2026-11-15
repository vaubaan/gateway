/**
 * How an Outlook account is made: the person signs in at Microsoft through
 * the OAuth broker this instance is enrolled with (`oauth2`, client source
 * `broker`; ADR outlook-through-the-oauth-broker-microsoft-provider).
 * Microsoft offers no app password for Exchange Online since basic
 * authentication was disabled, and no dynamic client registration; the
 * broker owns one Entra app registration with one redirect URI.
 *
 * Handbook : docs/handbook/services/outlook.md.
 *
 * The host runs the flow and refreshes through the broker; this plugin
 * receives an access token and never sees the refresh token or the broker key.
 */

import type { OAuth2BrokeredSpec } from '@vaubaan/plugin-sdk';

import { BROKER_PROVIDER, SCOPES } from './identity.ts';

/** Every scope asked, in the order the consent screen lists them. */
export const REQUESTED_SCOPES = [
  SCOPES.openid,
  SCOPES.email,
  SCOPES.profile,
  SCOPES.offlineAccess,
  SCOPES.userRead,
  SCOPES.mailReadWrite,
  SCOPES.mailSend,
  SCOPES.calendarsReadWrite,
] as const;

/** The Graph permissions the tools need; the OpenID scopes are not compared. */
export const REQUIRED_PERMISSIONS = [
  SCOPES.userRead,
  SCOPES.mailReadWrite,
  SCOPES.mailSend,
  SCOPES.calendarsReadWrite,
] as const;
export type RequiredPermission = (typeof REQUIRED_PERMISSIONS)[number];

export const outlookCredential: OAuth2BrokeredSpec = {
  kind: 'oauth2',
  broker: { provider: BROKER_PROVIDER },
  scopes: REQUESTED_SCOPES,
};

/** What a person reads for each permission, in Microsoft's consent words. */
const PERMISSION_LABEL: Readonly<Record<RequiredPermission, string>> = {
  [SCOPES.userRead]: 'sign you in and read your profile',
  [SCOPES.mailReadWrite]: 'read and write your mail',
  [SCOPES.mailSend]: 'send mail as you',
  [SCOPES.calendarsReadWrite]: 'have full access to your calendars',
};

const GRAPH_RESOURCE_PREFIX = 'https://graph.microsoft.com/';

/** A granted scope as compared: lower-cased, without Graph's resource prefix. */
function normalised(scope: string): string {
  const lower = scope.toLowerCase();
  return lower.startsWith(GRAPH_RESOURCE_PREFIX)
    ? lower.slice(GRAPH_RESOURCE_PREFIX.length)
    : lower;
}

/**
 * The Graph permissions Microsoft did not grant. Compared case-insensitively,
 * the `https://graph.microsoft.com/` prefix Microsoft may write tolerated. An
 * empty `granted` is "not reported" (the broker passes on what the token
 * endpoint answered), never "nothing granted": nothing is then missing.
 */
export function missingScopes(granted: readonly string[]): readonly RequiredPermission[] {
  if (granted.length === 0) return [];
  const has = new Set(granted.map(normalised));
  return REQUIRED_PERMISSIONS.filter((p) => !has.has(p.toLowerCase()));
}

/** What a person reads when Microsoft granted fewer permissions than asked (a `CredentialRefusal`). */
export function scopesNotGrantedMessage(missing: readonly RequiredPermission[]): string {
  const what = missing.map((p) => PERMISSION_LABEL[p]).join(', ');
  return `Microsoft did not grant every access asked for (missing: ${what}). Reconnect the account and accept every permission; an administrator of the organisation may have to consent first.`;
}
