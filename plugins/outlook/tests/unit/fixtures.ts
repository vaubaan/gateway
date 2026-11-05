/**
 * Shared fixtures of the `outlook` tests: the mailbox of a Microsoft 365
 * account (its zoning lists filled), an execution context with a brokered
 * access token, routes of Microsoft Graph, and one realistic sample per tool
 * (the coverage kit and the identifier proof both run on them). Ids follow
 * the shapes of Graph's documentation.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch, MockRoute, RecordedCall, ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { GRAPH_API_BASE, PROVIDER_ID, TOOL } from '../../src/identity.ts';

export const ACCOUNT = 'alice@contoso.example';
export const MAILBOX = 'alice~contoso.example';
/** Graph ids of the documentation's shape, without `+` or `=` so the slice carries them. */
export const MESSAGE = 'AAMkAGI2TG93AAA';
export const ATTACHMENT = 'AAMkAGI2TG93AAABEgAQAAtt';
export const DRAFT = 'AAMkADJmYWJjZjYtZTA0MS00YzUz';
export const FOLDER = 'AQMkADYAAAIBDAAAAA';
export const CALENDAR = 'AAMkAGI2TGuLAAA';
export const EVENT = 'AAMkAGIAAAoZDOFAAA';

export const mailbox: Resource = {
  provider: PROVIDER_ID,
  ref: MAILBOX,
  displayName: `Alice <${ACCOUNT}>`,
  metadata: {
    account_email: ACCOUNT,
    internal_domains: ['contoso.example'],
    allowlist_domains: ['partner.example'],
    allowlist_addresses: ['carol@customer.example'],
  },
};

export const TOKEN = 'eyJ0eXAiOiJKV1QiLCJub25jZSI6.brokered-access-token';

export function context(
  fetch: MockFetch | typeof globalThis.fetch,
  resources: readonly Resource[] = [mailbox],
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

export function graphUrl(path: string): string {
  return `${GRAPH_API_BASE}${path}`;
}

/** The method, the path below `/v1.0` and the query of a recorded call. */
export function requestOf(call: RecordedCall): {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
} {
  const url = new URL(call.url);
  return {
    method: call.method,
    path: url.pathname.replace('/v1.0', ''),
    query: Object.fromEntries(url.searchParams.entries()),
  };
}

/** A stored draft addressed to bob@contoso.example. */
export const STORED_DRAFT = {
  id: DRAFT,
  isDraft: true,
  toRecipients: [{ emailAddress: { address: 'Bob@Contoso.example' } }],
  ccRecipients: [],
  bccRecipients: [],
};

/** Routes the executors read before they write (the identifier proof needs them). */
export const READ_FIRST: readonly MockRoute[] = [
  // send_draft reads the stored draft.
  {
    method: 'GET',
    url: (url) => /\/me\/messages\/[^/?]+\?/.test(url) && url.includes('isDraft'),
    body: STORED_DRAFT,
  },
  // move_message to a folder id reads the refused folders and the parents.
  {
    method: 'GET',
    url: (url) => /\/me\/mailFolders\/[^/?]+\?/.test(url),
    respond: (call) => {
      const name = new URL(call.url).pathname.split('/').pop() ?? '';
      if (name === 'msgfolderroot') return { id: 'ROOT' };
      if (/^[a-z]+$/.test(name)) return { id: `ID-${name}`, parentFolderId: 'ROOT' };
      return { id: decodeURIComponent(name), parentFolderId: 'ROOT' };
    },
  },
  // get_attachment reads the attachment's description first.
  {
    method: 'GET',
    url: (url) => url.includes('/attachments/') && url.includes('%24select'),
    body: { '@odata.type': '#microsoft.graph.fileAttachment', id: ATTACHMENT, size: 12 },
  },
  // update_event with attendees reads the current ones.
  {
    method: 'GET',
    url: (url) => /\/events\/[^/?]+\?%24select=attendees$/.test(url),
    body: { attendees: [] },
  },
];

const at = { start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z' };
const range = { start: '2026-11-05T08:00:00Z', end: '2026-11-05T18:00:00Z' };

/** One table for the catalog coverage and the identifier proof. */
export const SAMPLES: ToolSamples = {
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
};
