/**
 * Google Calendar data model — the entity graph the classifier's slices and
 * the catalog's patterns are written on.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/google-calendar.md.
 *
 * One plane, `calendar`. The resource is one calendar of the account (ADR
 * google-calendar-through-an-oauth-broker). `guests` is a synthetic marker
 * the classifier emits when a call invites people: its identifier is the
 * zone of the people (`internal`, `external`), decided from the addresses
 * against the calendar's `internal_domains` — the way Gmail zones recipients.
 * `notify`, `response` and `delete` are verb leaves of an event. `free-busy`
 * is the availability of people, which no calendar of the mission bounds.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

export const googleCalendarDataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'calendar',
      description: 'The calendars of one Google account and their events.',
      entities: [
        {
          name: 'calendar',
          parent: null,
          // `bounded` : `list_calendars` names the calendars it reads as a list.
          cardinalities: ['one', 'bounded'],
          description:
            'The resource a connection exposes: one calendar of the account (the primary one, a secondary or a shared one).',
        },
        {
          name: 'event',
          parent: 'calendar',
          cardinalities: ['one', 'unbounded'],
          description: 'An event of the calendar, an instance of a recurring one included.',
        },
        {
          name: 'delete',
          parent: 'event',
          cardinalities: ['one'],
          description: 'Verb leaf: deleting the event (Google cancels it for its guests).',
        },
        {
          name: 'response',
          parent: 'event',
          cardinalities: ['one'],
          description:
            'Verb leaf: answering an invitation (accepted, tentative, declined); Google tells the organizer.',
        },
        {
          name: 'notify',
          parent: 'event',
          cardinalities: ['one'],
          description:
            "Verb leaf: Google emails the event's current guests about a change or a cancellation.",
        },
        {
          name: 'guests',
          parent: 'calendar',
          cardinalities: ['bounded'],
          description:
            'Synthetic marker: the people a call invites, by zone — `internal` (an address of an internal domain of the calendar) or `external` (any other). Not a Google entity.',
        },
        {
          name: 'free-busy',
          parent: null,
          cardinalities: ['one'],
          description:
            'The availability of people (busy slots, never the events themselves), read to suggest a time.',
        },
      ],
    },
  ],
};
