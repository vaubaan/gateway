/**
 * How a Google Calendar connection is made: the person signs in at Google
 * through the OAuth broker this instance is enrolled with (`oauth2`, client
 * source `broker`; ADR google-calendar-through-an-oauth-broker D1–D3). Google
 * offers neither a key a person can make for Calendar nor dynamic client
 * registration; the broker owns one verified client with one redirect URI.
 *
 * Handbook : docs/handbook/providers/google-calendar.md.
 *
 * The host runs the flow and refreshes through the broker; this plugin
 * receives an access token and never sees the refresh token or the broker key.
 * Calendar scopes are "sensitive", not "restricted", at Google.
 */

import type { OAuth2BrokeredSpec } from '@vaubaan/plugin-sdk';

import { BROKER_PROVIDER, SCOPES } from './identity.ts';

/** The four scopes the tools need, and nothing else (never the full `calendar` scope). */
export const REQUIRED_SCOPES = [
  SCOPES.calendarListRead,
  SCOPES.eventsRead,
  SCOPES.freeBusy,
  SCOPES.events,
] as const;

export const googleCalendarCredential: OAuth2BrokeredSpec = {
  kind: 'oauth2',
  broker: { provider: BROKER_PROVIDER },
  scopes: REQUIRED_SCOPES,
};

/** What a person reads for each required scope, on Google's consent screen terms. */
const SCOPE_LABEL: Readonly<Record<(typeof REQUIRED_SCOPES)[number], string>> = {
  [SCOPES.calendarListRead]: 'see the list of calendars',
  [SCOPES.eventsRead]: 'see events',
  [SCOPES.freeBusy]: 'see free/busy',
  [SCOPES.events]: 'edit events',
};

const FULL_CALENDAR = 'https://www.googleapis.com/auth/calendar';

/** Wider Google scopes that grant a required one (besides the full `calendar` scope). */
const WIDER: Readonly<Partial<Record<(typeof REQUIRED_SCOPES)[number], readonly string[]>>> = {
  [SCOPES.calendarListRead]: [
    'https://www.googleapis.com/auth/calendar.calendarlist',
    'https://www.googleapis.com/auth/calendar.readonly',
  ],
  [SCOPES.eventsRead]: [SCOPES.events, 'https://www.googleapis.com/auth/calendar.readonly'],
};

/**
 * The required scopes Google did not grant: with granular consent, a person
 * can untick one and Google still issues the token. An empty `granted` is
 * "not reported" (the broker passes on what Google's token endpoint answered),
 * never "nothing granted": nothing is then missing.
 */
export function missingScopes(
  granted: readonly string[],
): readonly (typeof REQUIRED_SCOPES)[number][] {
  if (granted.length === 0) return [];
  const has = new Set(granted);
  if (has.has(FULL_CALENDAR)) return [];
  return REQUIRED_SCOPES.filter(
    (scope) => !has.has(scope) && !(WIDER[scope] ?? []).some((w) => has.has(w)),
  );
}

/**
 * What a person reads when Google granted fewer scopes than asked (a
 * `CredentialRefusal`): the gateway's words, no text of Google's.
 */
export function scopesNotGrantedMessage(
  missing: readonly (typeof REQUIRED_SCOPES)[number][],
): string {
  const what = missing.map((s) => SCOPE_LABEL[s]).join(', ');
  return `Google did not grant every access asked for (missing: ${what}). Reconnect the account and tick every box on Google's consent screen.`;
}
