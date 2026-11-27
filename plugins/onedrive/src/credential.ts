/**
 * How a OneDrive account is made: the person signs in at Microsoft
 * (`oauth2`, client source `broker`): through Vaubaan's own client on an
 * instance on this computer (ADR local-instance-carries-installed-oauth-clients),
 * or a broker or a client of the instance's own elsewhere. Personal accounts
 * and work or school accounts alike.
 *
 * Handbook : docs/handbook/services/onedrive.md.
 *
 * The host runs the flow and refreshes; this plugin receives an access token
 * and never sees the refresh token.
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
  SCOPES.filesReadWrite,
] as const;

/** The Graph permissions the tools need; the OpenID scopes are not compared. */
export const REQUIRED_PERMISSIONS = [SCOPES.userRead, SCOPES.filesReadWrite] as const;

export const oneDriveCredential: OAuth2BrokeredSpec = {
  kind: 'oauth2',
  broker: { provider: BROKER_PROVIDER },
  scopes: REQUESTED_SCOPES,
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
 * The Graph permissions Microsoft did not grant, compared case-insensitively.
 * An empty `granted` is "not reported", never "nothing granted".
 */
export function missingScopes(granted: readonly string[]): readonly string[] {
  if (granted.length === 0) return [];
  const has = new Set(granted.map(normalised));
  return REQUIRED_PERMISSIONS.filter((p) => !has.has(p.toLowerCase()));
}

/** What a person reads when Microsoft granted fewer permissions than asked. */
export const SCOPES_NOT_GRANTED =
  'Microsoft did not grant access to your files. Reconnect the account and accept every permission; an administrator of the organisation may have to consent first.';
