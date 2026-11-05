/**
 * Representative calls of every tool of the `google-calendar` provider
 * (`ProviderPlugin.examples`) : the samples the plugin's tests run through the
 * kit (catalog coverage, identifier proof) and the site classifies when it
 * builds (ADR plugin-contract-and-credential-spec, amendment 2026-11-05). Two
 * calendars, the primary one of a Workspace account and a team calendar; ids
 * follow the shapes of Google's documentation.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from './identity.ts';

export const PRIMARY_ID = 'alice@acme.example';
export const PRIMARY = 'alice~acme.example';
export const TEAM_ID = 'c_0123abcd@group.calendar.google.com';
export const TEAM = 'c_0123abcd~group.calendar.google.com';
export const OTHER = 'bob~acme.example';
export const EVENT = '7kd8h3j2l1m0n9b8v7c6x5z4a3';

const zoning = { account_email: PRIMARY_ID, internal_domains: ['acme.example'] };

/** The primary calendar of a Workspace account. */
export const EXAMPLE_PRIMARY: Resource = {
  provider: PROVIDER_ID,
  ref: PRIMARY,
  displayName: 'Alice',
  metadata: { primary: true, access_role: 'owner', ...zoning },
};
/** A team calendar of the same account. */
export const EXAMPLE_TEAM: Resource = {
  provider: PROVIDER_ID,
  ref: TEAM,
  displayName: 'Team',
  metadata: { primary: false, access_role: 'writer', ...zoning },
};

const at = { startTime: '2026-11-03T10:00:00Z', endTime: '2026-11-03T11:00:00Z' };
const range = { timeMin: '2026-11-03T08:00:00Z', timeMax: '2026-11-03T18:00:00Z' };

export const googleCalendarExamples: ToolSamples = samplesOn([EXAMPLE_PRIMARY, EXAMPLE_TEAM], {
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
});
