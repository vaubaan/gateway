/**
 * Outlook data model — the entity graph the classifier's slices and the
 * catalog's patterns are written on.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/outlook.md.
 *
 * Two planes of one Microsoft account, reached by one token:
 *
 *   - `mail`, rooted at `mailbox`, whose identifier is the resource ref (the
 *     account's address with `@` written `~`), so every mail slice names the
 *     mission resource. `from-zone`, `to-zone`, `send-zone` and `bulk-marker`
 *     are synthetic markers, Gmail's zoning model: who sent what is read, who
 *     receives what is written. No sensitive-label marker in this version
 *     (Outlook categories could play that part later).
 *   - `calendar`, rooted at `calendar` (`default` or a calendar id; calendars
 *     are not resources), modelled as Google Calendar is: `event` with the
 *     verb leaves `delete`, `response` and `notify`, the `guests` marker by
 *     zone, and `free-busy`, the availability of people.
 *
 * Cardinalities are the ways slices name an entity: `one` (an identifier, or
 * none for a creation or a marker), `unbounded` (`[*]`: a list, or an
 * identifier the slice grammar cannot carry, `identSegment`).
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

export const outlookDataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'mail',
      description: 'The mailbox of one Microsoft account: folders, messages, attachments, drafts.',
      entities: [
        {
          name: 'mailbox',
          parent: null,
          cardinalities: ['one', 'unbounded'],
          description:
            'The resource an account exposes: the mailbox of the account. Its identifier is the ref (alice~contoso.com); an address the slice grammar cannot carry is written [*].',
        },
        {
          name: 'folder',
          parent: 'mailbox',
          cardinalities: ['one', 'unbounded'],
          description: 'A mail folder (Inbox, Archive, a folder of the person).',
        },
        {
          name: 'message',
          parent: 'mailbox',
          cardinalities: ['one', 'unbounded'],
          description: 'A message, by its immutable id; a list of messages is [*].',
        },
        {
          name: 'attachment',
          parent: 'message',
          cardinalities: ['one', 'unbounded'],
          description: 'An attachment of a message (a file, an attached item, a link).',
        },
        {
          name: 'draft',
          parent: 'mailbox',
          cardinalities: ['one', 'unbounded'],
          description: 'An unsent message of the Drafts folder; without an identifier, a new one.',
        },
        {
          name: 'from-zone',
          parent: 'mailbox',
          cardinalities: ['one'],
          description:
            'Synthetic marker: the zone of the senders a read reveals — automated, internal, known-external, unknown — from the mailbox metadata. Not a Graph entity.',
        },
        {
          name: 'to-zone',
          parent: 'mailbox',
          cardinalities: ['one'],
          description:
            'Synthetic marker: the worst zone of the recipients of a draft — self, internal, allowlist. Not a Graph entity.',
        },
        {
          name: 'send-zone',
          parent: 'mailbox',
          cardinalities: ['one'],
          description:
            'Synthetic marker: the worst zone of the recipients of a send — self, internal, allowlist, external-unbounded. Not a Graph entity.',
        },
        {
          name: 'bulk-marker',
          parent: 'mailbox',
          cardinalities: ['one'],
          description:
            'Synthetic marker: a search not bounded by exactly one from: address, which may return mail of anyone.',
        },
      ],
    },
    {
      slug: 'calendar',
      description: 'The calendars of the account, their events, and the availability of people.',
      entities: [
        {
          name: 'calendar',
          parent: null,
          cardinalities: ['one', 'unbounded'],
          description:
            'A calendar of the account: `default` for its default calendar, or a calendar id; the list of calendars is [*].',
        },
        {
          name: 'event',
          parent: 'calendar',
          cardinalities: ['one', 'unbounded'],
          description: 'An event of the calendar, an occurrence of a recurring one included.',
        },
        {
          name: 'delete',
          parent: 'event',
          cardinalities: ['one'],
          description: 'Verb leaf: deleting the event (Exchange cancels it for its attendees).',
        },
        {
          name: 'response',
          parent: 'event',
          cardinalities: ['one'],
          description: 'Verb leaf: answering an invitation (accept, tentative, decline).',
        },
        {
          name: 'notify',
          parent: 'event',
          cardinalities: ['one'],
          description:
            "Verb leaf: Exchange mails the event's attendees about a change or a cancellation.",
        },
        {
          name: 'guests',
          parent: 'calendar',
          cardinalities: ['one'],
          description:
            'Synthetic marker: the people a call invites, by zone — internal (an internal domain of the mailbox) or external. Not a Graph entity.',
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
