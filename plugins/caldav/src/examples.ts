/**
 * Representative calls of every tool of the `caldav` provider
 * (`ProviderPlugin.examples`) : the samples the plugin's tests run through the
 * kit and the site classifies when it builds (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * One sample per branch that matters ; every risk of the catalog is reached.
 * Unless a sample names its own, it runs on the calendar `work`.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { CALDAV_PLUGIN_ID, TOOL } from './identity.ts';

const HOME = 'https://cal.example.com/dav/calendars/ada/';

/** A calendar resource as discovery returns it, zoned by its owner. */
function exampleCalendar(ref: string): Resource {
  return {
    provider: CALDAV_PLUGIN_ID,
    ref,
    displayName: ref,
    metadata: {
      href: `${HOME}${ref}/`,
      account_addresses: 'ada@example.com',
      internal_domains: ['example.com'],
      allowlist_domains: ['partner.org'],
      allowlist_addresses: ['bob@vendor.io'],
    },
  };
}

export const EXAMPLE_WORK_CALENDAR = exampleCalendar('work');
export const EXAMPLE_HOME_CALENDAR = exampleCalendar('home');
/** A resource of another provider : a mission holding no calendar. */
const FOREIGN_RESOURCE: Resource = {
  provider: 'github',
  ref: 'acme/app',
  displayName: 'acme/app',
};

const RANGE = { start: '2026-10-26', end: '2026-11-02' };
const EVENT = { summary: 'Sync', start: '2026-10-27T09:00:00Z', end: '2026-10-27T10:00:00Z' };
const TARGET = { event_id: 'evt-1.ics', etag: '"e1"' };

export const caldavExamples: ToolSamples = samplesOn([EXAMPLE_WORK_CALENDAR], {
  [TOOL.listCalendars]: [
    { args: {} },
    { args: {}, resources: [FOREIGN_RESOURCE], expectDenied: true },
  ],
  [TOOL.listEvents]: [
    { args: RANGE },
    { args: { calendar: 'work', start: '2026-10-01', end: '2026-12-01', max_results: 200 } },
    { args: RANGE, resources: [EXAMPLE_WORK_CALENDAR, EXAMPLE_HOME_CALENDAR], expectDenied: true },
    { args: { start: '2026-10-01', end: '2027-12-01' }, expectDenied: true },
  ],
  [TOOL.getEvent]: [
    { args: { event_id: 'evt-1.ics' } },
    { args: { event_id: 'abc@google.com.ics' } },
    { args: { event_id: '..' }, expectDenied: true },
  ],
  [TOOL.createEvent]: [
    { args: EVENT },
    { args: { ...EVENT, attendees: ['bob@example.com'] } },
    { args: { ...EVENT, attendees: ['carol@partner.org'] } },
    { args: { ...EVENT, attendees: ['mallory@evil.example'] } },
    { args: { ...EVENT, raw: 'BEGIN:VCALENDAR' }, expectDenied: true },
  ],
  [TOOL.updateEvent]: [
    { args: { ...TARGET, summary: 'x' } },
    {
      args: { ...TARGET, attendees: ['bob@example.com'], removed_attendees: ['carol@partner.org'] },
    },
    { args: { ...TARGET }, expectDenied: true },
  ],
  [TOOL.deleteEvent]: [
    { args: TARGET },
    { args: { ...TARGET, attendees: ['mallory@evil.example'] } },
    { args: { event_id: 'evt-1.ics' }, expectDenied: true },
  ],
});
