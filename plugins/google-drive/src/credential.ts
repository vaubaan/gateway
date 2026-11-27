/**
 * How a Google Drive account is made: the person signs in at Google
 * (`oauth2`, client source `broker`): through Vaubaan's own client on an
 * instance on this computer (ADR local-instance-carries-installed-oauth-clients),
 * or a broker or a client of the instance's own elsewhere.
 *
 * Handbook : docs/handbook/services/google-drive.md.
 *
 * The host runs the flow and refreshes; this plugin receives an access token
 * and never sees the refresh token. `drive` is a "restricted" scope at
 * Google: until the client passes Google's review, the consent screen warns
 * of an unverified app.
 */

import type { OAuth2BrokeredSpec } from '@vaubaan/plugin-sdk';

import { BROKER_PROVIDER, SCOPES } from './identity.ts';

/** The one scope the tools need. */
export const REQUIRED_SCOPES = [SCOPES.drive] as const;

export const googleDriveCredential: OAuth2BrokeredSpec = {
  kind: 'oauth2',
  broker: { provider: BROKER_PROVIDER },
  scopes: REQUIRED_SCOPES,
};

/**
 * The required scopes Google did not grant: with granular consent, a person
 * can untick one and Google still issues the token. An empty `granted` is
 * "not reported", never "nothing granted": nothing is then missing.
 */
export function missingScopes(granted: readonly string[]): readonly string[] {
  if (granted.length === 0) return [];
  const has = new Set(granted);
  return REQUIRED_SCOPES.filter((scope) => !has.has(scope));
}

/** What a person reads when Google granted fewer scopes than asked: the gateway's words. */
export const SCOPES_NOT_GRANTED =
  "Google did not grant access to your Drive files. Reconnect the account and tick the Drive box on Google's consent screen.";
