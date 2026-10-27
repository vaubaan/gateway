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
