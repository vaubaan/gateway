/**
 * Representative calls of every tool of the `outlook` service
 * (`ServicePlugin.examples`): the samples the plugin's tests run through the
 * kit (catalog coverage, data model, identifier proof) and the site classifies
 * when it builds (ADR plugin-contract-and-credential-spec, amendment
 * 2026-11-05). One realistic call per tool, on a Microsoft 365 mailbox whose
 * zoning lists are filled, and the refused ones. Ids follow the shapes of
 * Graph's documentation.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';

export const ACCOUNT = 'alice@contoso.example';
export const MAILBOX = 'alice~contoso.example';
/** Graph ids of the documentation's shape, without `+` or `=` so the slice carries them. */
export const MESSAGE = 'AAMkAGI2TG93AAA';
export const ATTACHMENT = 'AAMkAGI2TG93AAABEgAQAAtt';
export const DRAFT = 'AAMkADJmYWJjZjYtZTA0MS00YzUz';
export const FOLDER = 'AQMkADYAAAIBDAAAAA';
export const CALENDAR = 'AAMkAGI2TGuLAAA';
export const EVENT = 'AAMkAGIAAAoZDOFAAA';

/** The mailbox the samples run on: internal domain, allowlisted domain and address. */
export const EXAMPLE_MAILBOX: Resource = {
  service: SERVICE_ID,
  ref: MAILBOX,
  displayName: `Alice <${ACCOUNT}>`,
  metadata: {
    account_email: ACCOUNT,
    internal_domains: ['contoso.example'],
    allowlist_domains: ['partner.example'],
    allowlist_addresses: ['carol@customer.example'],
  },
};

const at = { start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z' };
const range = { start: '2026-11-05T08:00:00Z', end: '2026-11-05T18:00:00Z' };

export const outlookExamples: ToolSamples = samplesOn([EXAMPLE_MAILBOX], {
  [TOOL.describeZones]: [{ args: {} }],
  [TOOL.listFolders]: [{ args: {} }, { args: { parent: FOLDER } }],
  [TOOL.searchMessages]: [
    { args: { query: 'from:bob@contoso.example is:unread' } },
    { args: { query: 'from:noreply@contoso.example' } },
    { args: { query: 'from:carol@customer.example invoice', folder: 'inbox', top: 5 } },
    { args: { query: 'budget', folder: 'drafts' } },
    { args: { query: 'from:a@x.example OR from:b@x.example' }, expectDenied: true },
  ],
  [TOOL.getMessage]: [{ args: { message_id: MESSAGE } }],
  [TOOL.listAttachments]: [{ args: { message_id: MESSAGE } }],
  [TOOL.getAttachment]: [{ args: { message_id: MESSAGE, attachment_id: ATTACHMENT } }],
  [TOOL.listDrafts]: [{ args: { top: 10 } }],
  [TOOL.createDraft]: [
    { args: { subject: 'Note', body: 'for me' } },
    { args: { to: ['bob@contoso.example'], subject: 'Plan', body: 'draft' } },
    { args: { to: ['dan@partner.example'], subject: 'Offer', body: 'draft' } },
    { args: { to: ['eve@elsewhere.example'], subject: 'x', body: 'y' }, expectDenied: true },
  ],
  [TOOL.createReplyDraft]: [
    { args: { message_id: MESSAGE, body: 'Thanks', to: ['bob@contoso.example'] } },
  ],
  [TOOL.sendMessage]: [
    { args: { to: [ACCOUNT], subject: 'Report', body: 'done' } },
    { args: { to: ['bob@contoso.example'], subject: 'Report', body: 'done' } },
    { args: { to: ['carol@customer.example'], subject: 'Report', body: 'done' } },
    { args: { to: ['eve@elsewhere.example'], subject: 'Report', body: 'done' } },
  ],
  [TOOL.sendDraft]: [{ args: { draft_id: DRAFT, to: ['bob@contoso.example'] } }],
  [TOOL.moveMessage]: [
    { args: { message_id: MESSAGE, folder: 'archive' } },
    { args: { message_id: MESSAGE, folder: FOLDER } },
    { args: { message_id: MESSAGE, folder: 'deleteditems' }, expectDenied: true },
  ],
  [TOOL.updateMessage]: [{ args: { message_id: MESSAGE, is_read: true, flag: 'flagged' } }],
  [TOOL.createFolder]: [
    { args: { name: 'Clients 2026' } },
    { args: { name: 'Q4', parent: FOLDER } },
  ],
  [TOOL.listCalendars]: [{ args: {} }],
  [TOOL.listEvents]: [{ args: { ...range } }, { args: { calendar: CALENDAR, ...range, top: 10 } }],
  [TOOL.searchEvents]: [{ args: { text: 'review' } }, { args: { text: 'review', ...range } }],
  [TOOL.getEvent]: [{ args: { event_id: EVENT } }],
  [TOOL.suggestTime]: [{ args: { attendees: ['bob@contoso.example'], ...range } }],
  [TOOL.createEvent]: [
    { args: { subject: 'Focus', ...at } },
    {
      args: {
        calendar: CALENDAR,
        subject: 'Sync',
        ...at,
        attendees: ['bob@contoso.example', 'carol@customer.example'],
      },
    },
  ],
  [TOOL.updateEvent]: [
    { args: { event_id: EVENT, subject: 'Sync (moved)', ...at } },
    { args: { event_id: EVENT, added_attendees: ['bob@contoso.example'] } },
  ],
  [TOOL.deleteEvent]: [{ args: { event_id: EVENT } }],
  [TOOL.respondToEvent]: [{ args: { event_id: EVENT, response: 'accept' } }],
});
