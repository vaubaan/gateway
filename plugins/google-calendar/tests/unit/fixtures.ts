/**
 * Shared fixtures of the `google-calendar` tests: two calendars (the primary
 * one of a Workspace account and a team calendar), an execution context with
 * a brokered access token, routes of Google's Calendar REST API, and one
 * realistic sample per tool (the coverage kit and the identifier proof both
 * run on them). Ids follow the shapes of Google's documentation.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch, MockRoute, RecordedCall, ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { CALENDAR_API_BASE, PROVIDER_ID, TOOL } from '../../src/identity.ts';

export const PRIMARY_ID = 'alice@acme.example';
export const PRIMARY = 'alice~acme.example';
export const TEAM_ID = 'c_0123abcd@group.calendar.google.com';
export const TEAM = 'c_0123abcd~group.calendar.google.com';
export const OTHER = 'bob~acme.example';
export const EVENT = '7kd8h3j2l1m0n9b8v7c6x5z4a3';

const zoning = { account_email: PRIMARY_ID, internal_domains: ['acme.example'] };

export const primary: Resource = {
  provider: PROVIDER_ID,
  ref: PRIMARY,
  displayName: 'Alice',
  metadata: { primary: true, access_role: 'owner', ...zoning },
};
export const team: Resource = {
  provider: PROVIDER_ID,
  ref: TEAM,
  displayName: 'Team',
  metadata: { primary: false, access_role: 'writer', ...zoning },
};

export const TOKEN = 'ya29.brokered-access-token-1234567890';

export function context(
  fetch: MockFetch | typeof globalThis.fetch,
  resources: readonly Resource[] = [primary, team],
  scopes: readonly string[] = [],
): ExecuteContext {
  return {
    credential: {
      kind: 'oauth2',
      accessToken: TOKEN,
      refreshToken: null,
      expiresAt: null,
      scopes,
      metadata: {},
    },
    fetch,
    resources,
  };
}

/** The URL of a path of the API, the calendar id percent-encoded as the executor writes it. */
export function api(path: string): string {
  return `${CALENDAR_API_BASE}${path}`;
}

/** The path and the query of a recorded call, the query as an object. */
export function requestOf(call: RecordedCall): {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
} {
  const url = new URL(call.url);
  return {
    method: call.method,
    path: url.pathname.replace('/calendar/v3', ''),
    query: Object.fromEntries(url.searchParams.entries()),
  };
}

/** One event as Google answers it to `maxAttendees=1`, this account's entry marked `self`. */
export const INVITATION = {
  id: EVENT,
  summary: 'Quarterly review',
  attendeesOmitted: true,
  attendees: [{ email: PRIMARY_ID, self: true, responseStatus: 'needsAction' }],
};

/** A GET of one event answers `INVITATION`. */
export const EVENT_GET: MockRoute = {
  method: 'GET',
  url: (url) => /\/events\/[^/?]+(\?|$)/.test(url),
  body: INVITATION,
};

const at = { startTime: '2026-11-03T10:00:00Z', endTime: '2026-11-03T11:00:00Z' };
const range = { timeMin: '2026-11-03T08:00:00Z', timeMax: '2026-11-03T18:00:00Z' };

/** One table for the catalog coverage and the identifier proof. */
export const SAMPLES: ToolSamples = {
  [TOOL.listCalendars]: [{ args: {} }],
  [TOOL.listEvents]: [
    { args: { calendarId: TEAM, ...range, orderBy: 'startTime', maxResults: 10 } },
    { args: { calendarId: OTHER }, expectDenied: true },
  ],
  [TOOL.searchEvents]: [{ args: { q: 'quarterly review' } }],
  [TOOL.getEvent]: [{ args: { calendarId: PRIMARY_ID, eventId: EVENT } }],
  [TOOL.suggestTime]: [
    { args: { attendeeEmails: ['bob@acme.example'], ...range, durationMinutes: 30 } },
  ],
  [TOOL.createEvent]: [
    { args: { summary: 'Focus', ...at } },
    {
      args: {
        summary: 'Sync',
        ...at,
        attendees: [{ email: 'bob@acme.example' }, { email: 'carol@customer.example' }],
      },
    },
  ],
  [TOOL.updateEvent]: [
    { args: { eventId: EVENT, summary: 'Sync (moved)', ...at } },
    { args: { eventId: EVENT, calendarId: TEAM, location: 'Room 2', sendUpdates: 'none' } },
  ],
  [TOOL.deleteEvent]: [{ args: { eventId: EVENT, sendUpdates: 'none' } }],
  [TOOL.respondToEvent]: [{ args: { eventId: EVENT, responseStatus: 'accepted' } }],
};
