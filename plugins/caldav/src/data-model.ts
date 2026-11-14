/**
 * CalDAV data model — the `calendar` plane.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/caldav.md.
 *
 * One account is one CalDAV account (a server, a username, an app
 * password). Its principal has one calendar home holding the calendars ; each
 * calendar that stores events is one **resource**, labelled by its owner. An
 * event is one calendar object resource (an `.ics` file) of a calendar.
 *
 * Like Gmail, the risk of a write depends on **who** it reaches, not on what
 * it contains : a CalDAV server that implements scheduling (RFC 6638 —
 * iCloud, Fastmail, Nextcloud) sends an invitation, an update or a
 * cancellation to the attendees of an event the account organizes, and a
 * reply to its organizer when the account is only invited. The classifier
 * says who that is with a synthetic marker, `attendee-zone[<zone>]`, and a
 * long read with another, `wide-range`. Neither is a CalDAV entity.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { CALDAV_PLUGIN_ID } from './identity.ts';

export const caldavDataModel: DataModel = {
  provider: CALDAV_PLUGIN_ID,
  planes: [
    {
      slug: 'calendar',
      description:
        'The calendars of one CalDAV account and their events. Synthetic markers ' +
        '(`attendee-zone`, `wide-range`) are entities for slice matching only.',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one'],
          description:
            'The CalDAV principal the app password signs in as (RFC 5397 ' +
            '`current-user-principal`). One per account ; its calendar home holds the calendars.',
        },
        {
          name: 'calendar',
          parent: 'account',
          cardinalities: ['bounded'],
          envScopable: true,
          description:
            'A calendar collection of the home that stores events (VEVENT). One mission ' +
            'resource per calendar ; the ref is the last segment of its address. Carries the ' +
            'owner label and the zoning lists (`internal_domains`, `allowlist_domains`, ' +
            '`allowlist_addresses`) in its metadata.',
        },
        {
          name: 'event',
          parent: 'calendar',
          cardinalities: ['unbounded'],
          description:
            'A calendar object resource : one `.ics` holding one event, its recurrence rule ' +
            'and its changed occurrences. The identifier is its file name in the calendar.',
        },
        {
          name: 'delete',
          parent: 'event',
          cardinalities: ['one'],
          description:
            'Synthetic verb leaf — deleting an event. Distinct from a change : CalDAV keeps ' +
            'no history and no bin, the event is gone.',
        },
        {
          name: 'attendee-zone',
          parent: 'calendar',
          cardinalities: ['bounded'],
          description:
            'Synthetic marker of a write that notifies people : `internal`, `allowlist` or ' +
            '`external`, the worst zone of the attendees and organizer other than the account ' +
            'itself. Absent when the event concerns nobody else.',
        },
        {
          name: 'wide-range',
          parent: 'calendar',
          cardinalities: ['one'],
          description:
            'Synthetic marker of a read over more than 31 days : a long stretch of agenda ' +
            'in one call.',
        },
      ],
    },
  ],
};
