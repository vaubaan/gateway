/**
 * MCP tools of the `outlook` provider — the plugin's own, each implemented on
 * Microsoft Graph v1.0 (`mail.ts`, `calendar.ts`).
 *
 * ADR      : docs/decisions/outlook-through-the-oauth-broker-microsoft-provider.md.
 * Handbook : docs/handbook/providers/outlook.md.
 *
 * Every tool takes `mailbox`, the account of the mission (its ref or its
 * address), the mission's single mailbox when omitted. The calendar tools
 * take `calendar` (`default` when omitted). `call.ts` reads every call
 * against these schemas: an undeclared argument is refused; types, enums and
 * bounds are checked.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { FLAG_STATUSES, RESPONSE_ACTION, TOOL } from './identity.ts';

/** The most messages one search or one draft list returns. */
export const MAX_MESSAGES_PER_PAGE = 50;
/** The most events one page of `list_events` / `search_events` returns. */
export const MAX_EVENTS_PER_PAGE = 250;
/** The most recipients of one send, To, Cc and Bcc together (the plugin's bound). */
export const MAX_SEND_RECIPIENTS = 100;
/** The most people `suggest_time` asks about besides the account (the plugin's bound). */
export const MAX_FREE_BUSY_PEOPLE = 20;
/** The most attendees one create or update names. */
export const MAX_ATTENDEES = 100;
/** The most categories one update sets. */
export const MAX_CATEGORIES = 25;

const MAILBOX = {
  mailbox: {
    type: 'string',
    description:
      'The mailbox of this mission: its ref (alice~contoso.com) or its address (alice@contoso.com). Omitted: the mission’s single mailbox.',
  },
} as const;

const CALENDAR = {
  calendar: {
    type: 'string',
    description:
      'A calendar id from outlook__list_calendars, or "default" (the account’s default calendar). Omitted: default.',
  },
} as const;

const id = (what: string) => ({ type: 'string', description: `${what} (a Graph id).` }) as const;

const recipients = (what: string) =>
  ({
    type: 'array',
    items: { type: 'string' },
    description: `${what}: addresses, one bare address (addr@contoso.com) per element. An element that is not exactly one address refuses the call.`,
  }) as const;

const SUBJECT = { type: 'string', description: 'The subject.' } as const;
const BODY = { type: 'string', description: 'The body, plain text (never HTML).' } as const;

const TOP = (max: number, byDefault: number) =>
  ({
    type: 'integer',
    minimum: 1,
    maximum: max,
    description: `How many to return, 1 to ${max}. Default ${byDefault}. The first page only.`,
  }) as const;

const RANGE = {
  start: {
    type: 'string',
    description: 'Start of the time range, RFC 3339 with an offset (2026-11-05T00:00:00Z).',
  },
  end: {
    type: 'string',
    description: 'End of the time range, RFC 3339 with an offset; after start.',
  },
} as const;

const WHEN = {
  start: {
    type: 'string',
    description:
      'Start: RFC 3339 with an offset (2026-11-05T10:00:00+01:00), or a local date-time (2026-11-05T10:00) when time_zone is given.',
  },
  end: { type: 'string', description: 'End, in the same form as start; after start.' },
  time_zone: {
    type: 'string',
    description:
      'Time zone of a local start and end: a Windows name (W. Europe Standard Time) or an IANA one (Europe/Paris).',
  },
} as const;

const EVENT_TEXT = {
  subject: SUBJECT,
  body: { type: 'string', description: 'The event body, plain text.' },
  location: { type: 'string', description: 'The place, as free text.' },
} as const;

const ATTENDEES = (what: string) =>
  ({
    type: 'array',
    items: { type: 'string' },
    description: `${what}: one bare address per element. Inviting people inside and outside the company are separate permissions.`,
  }) as const;

export const outlookTools: readonly McpToolDeclaration[] = [
  // ─── Mail ─────────────────────────────────────────────────────────────
  {
    name: TOOL.describeZones,
    description:
      'Return the zoning of the mailbox (its address, internal domains, allowlisted domains and addresses), so the agent knows which permissions a read, a draft or a send needs. Answered by the gateway, without a call to Microsoft.',
    inputSchema: { type: 'object', properties: { ...MAILBOX } },
  },
  {
    name: TOOL.listFolders,
    description:
      'List the mail folders at the top of the mailbox, or the child folders of parent: id, name, counts. At most 100.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        parent: {
          type: 'string',
          description:
            'A folder id, or a well-known name (inbox, archive…), whose child folders to list.',
        },
      },
    },
  },
  {
    name: TOOL.searchMessages,
    description:
      'Search messages, newest first, without their bodies (a preview of each is returned). The query is a conjunction of terms: from:<address>, to:<address>, subject:<word>, is:unread, has:attachment, after:<YYYY-MM-DD>, before:<YYYY-MM-DD>, and free words searched in sender, subject and body. Only a query with exactly one from:<address> is a read of that sender; anything else is a bulk read from unknown senders.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        query: { type: 'string', description: 'The query; empty: the newest messages.' },
        folder: {
          type: 'string',
          description:
            'A well-known folder name (inbox, sentitems, archive…) or a folder id. Omitted: every folder.',
        },
        top: TOP(MAX_MESSAGES_PER_PAGE, 10),
      },
      required: ['query'],
    },
  },
  {
    name: TOOL.getMessage,
    description:
      'Read one message: headers, recipients, the text body (HTML converted to text by Microsoft), whether it has attachments. Classified as a read from an unknown sender: the sender is only known after the fetch.',
    inputSchema: {
      type: 'object',
      properties: { ...MAILBOX, message_id: id('The message id from search_messages') },
      required: ['message_id'],
    },
  },
  {
    name: TOOL.listAttachments,
    description:
      'List the attachments of a message: id, name, type, size. Classified like get_message.',
    inputSchema: {
      type: 'object',
      properties: { ...MAILBOX, message_id: id('The message id') },
      required: ['message_id'],
    },
  },
  {
    name: TOOL.getAttachment,
    description:
      'Download one file attachment of a message, base64-encoded, at most 7 MB (a larger one is refused). An attached item or a link is described, not downloaded. Classified like get_message.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        message_id: id('The message id'),
        attachment_id: id('The attachment id from list_attachments'),
      },
      required: ['message_id', 'attachment_id'],
    },
  },
  {
    name: TOOL.listDrafts,
    description:
      'List the drafts of the Drafts folder, newest first, with their recipients (Bcc included).',
    inputSchema: {
      type: 'object',
      properties: { ...MAILBOX, top: TOP(MAX_MESSAGES_PER_PAGE, 25) },
    },
  },
  {
    name: TOOL.createDraft,
    description:
      'Create a plain-text draft in Drafts; it is not sent. The permission depends on the recipients: self, internal or allowlisted. A recipient outside the internal domains and the allowlists refuses the draft.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        to: recipients('To'),
        cc: recipients('Cc'),
        bcc: recipients('Bcc'),
        subject: SUBJECT,
        body: BODY,
      },
      required: ['subject', 'body'],
    },
  },
  {
    name: TOOL.createReplyDraft,
    description:
      'Create a draft replying to a message (reply_all: to everyone it was sent to), with the original quoted under the body; it is not sent. Its recipients are exactly to and cc as given, whatever Microsoft would have filled in: name them (the sender, and for a reply to all, its recipients). A recipient outside the internal domains and the allowlists refuses the draft.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        message_id: id('The message to reply to'),
        body: BODY,
        to: recipients('To'),
        cc: recipients('Cc'),
        reply_all: {
          type: 'boolean',
          description: 'Reply to all (createReplyAll). Default false.',
        },
      },
      required: ['message_id', 'body', 'to'],
    },
  },
  {
    name: TOOL.sendMessage,
    description:
      'Send a plain-text message from the mailbox; it cannot be called back. The permission depends on the worst recipient: self, internal, allowlisted or external. 1 to 100 recipients. Saved in Sent Items.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        to: recipients('To'),
        cc: recipients('Cc'),
        bcc: recipients('Bcc'),
        subject: SUBJECT,
        body: BODY,
      },
      required: ['subject', 'body'],
    },
  },
  {
    name: TOOL.sendDraft,
    description:
      'Send an existing draft as it is (attachments and formatting kept); it cannot be called back. Give its id and its recipients exactly as list_drafts shows them: the permission is priced on them, and the call is refused, unsent, when the draft holds others.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        draft_id: id('The draft id from list_drafts'),
        to: recipients('To'),
        cc: recipients('Cc'),
        bcc: recipients('Bcc'),
      },
      required: ['draft_id', 'to'],
    },
  },
  {
    name: TOOL.moveMessage,
    description:
      'Move a message to another folder. Deleted Items, Junk Email, the recoverable items, the Outbox and any folder under them are refused: deleting is not offered.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        message_id: id('The message id'),
        folder: {
          type: 'string',
          description: 'The destination: a well-known name (inbox, archive…) or a folder id.',
        },
      },
      required: ['message_id', 'folder'],
    },
  },
  {
    name: TOOL.updateMessage,
    description:
      'Mark a message read or unread, set its follow-up flag, or replace its categories. Give at least one.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        message_id: id('The message id'),
        is_read: { type: 'boolean', description: 'true: read; false: unread.' },
        flag: { type: 'string', enum: [...FLAG_STATUSES], description: 'The follow-up flag.' },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: `The categories, replacing the current ones; at most ${MAX_CATEGORIES}.`,
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: TOOL.createFolder,
    description: 'Create a mail folder at the top of the mailbox, or under parent. Moves nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        name: { type: 'string', description: 'The folder name, 1 to 255 characters.' },
        parent: {
          type: 'string',
          description: 'A folder id or a well-known name to create it under. Omitted: the top.',
        },
      },
      required: ['name'],
    },
  },
  // ─── Calendar ─────────────────────────────────────────────────────────
  {
    name: TOOL.listCalendars,
    description:
      'List the calendars of the account: id, name, whether it is the default one, whether it may be edited, its owner. At most 100.',
    inputSchema: { type: 'object', properties: { ...MAILBOX } },
  },
  {
    name: TOOL.listEvents,
    description:
      'List the events of a calendar in a time range, recurring ones expanded into their occurrences, ordered by start. Times are UTC.',
    inputSchema: {
      type: 'object',
      properties: { ...MAILBOX, ...CALENDAR, ...RANGE, top: TOP(MAX_EVENTS_PER_PAGE, 50) },
      required: ['start', 'end'],
    },
  },
  {
    name: TOOL.searchEvents,
    description:
      'Search the events of a calendar whose subject contains text, in a time range when start and end are given (occurrences expanded), otherwise among its events. Text matching, not semantic search.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        ...CALENDAR,
        text: {
          type: 'string',
          description: 'The text the subject contains, 1 to 255 characters.',
        },
        ...RANGE,
        top: TOP(MAX_EVENTS_PER_PAGE, 50),
      },
      required: ['text'],
    },
  },
  {
    name: TOOL.getEvent,
    description: 'Read one event of a calendar, its attendees and body included.',
    inputSchema: {
      type: 'object',
      properties: { ...MAILBOX, ...CALENDAR, event_id: id('The event id') },
      required: ['event_id'],
    },
  },
  {
    name: TOOL.suggestTime,
    description:
      'Suggest times when this account and the people named are all free, from their free/busy (never their events) as far as Exchange shares it. Returns the free slots of at least duration_minutes inside the range, and the people whose availability could not be read.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: `1 to ${MAX_FREE_BUSY_PEOPLE} addresses; this account is always included.`,
        },
        ...RANGE,
        duration_minutes: {
          type: 'integer',
          minimum: 5,
          maximum: 1440,
          description: 'Length of the meeting, 5 to 1440 minutes. Default 30.',
        },
        max_suggestions: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'How many slots to return, 1 to 50. Default 10.',
        },
      },
      required: ['attendees', 'start', 'end'],
    },
  },
  {
    name: TOOL.createEvent,
    description:
      'Create an event on a calendar. Each attendee is one address; Exchange mails them the invitation. Inviting people inside and outside the company are separate permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        ...CALENDAR,
        ...EVENT_TEXT,
        ...WHEN,
        attendees: ATTENDEES('The people to invite'),
      },
      required: ['subject', 'start', 'end'],
    },
  },
  {
    name: TOOL.updateEvent,
    description:
      'Change an event: only the fields given change; start and end go together. Exchange mails the change to the attendees of a meeting this account organises, and Graph cannot turn that off: every update needs the permission to notify them.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        ...CALENDAR,
        event_id: id('The event id'),
        ...EVENT_TEXT,
        ...WHEN,
        added_attendees: ATTENDEES('People to invite'),
        removed_attendee_emails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attendees to remove, by address.',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: TOOL.deleteEvent,
    description:
      'Delete an event. On a meeting this account organises, Exchange sends the attendees a cancellation, which Graph cannot turn off: a permission of its own.',
    inputSchema: {
      type: 'object',
      properties: { ...MAILBOX, ...CALENDAR, event_id: id('The event id') },
      required: ['event_id'],
    },
  },
  {
    name: TOOL.respondToEvent,
    description:
      'Answer an invitation this account received: accept, tentative or decline, with an optional comment. send_response true mails the answer to the organizer (default false).',
    inputSchema: {
      type: 'object',
      properties: {
        ...MAILBOX,
        ...CALENDAR,
        event_id: id('The event id'),
        response: { type: 'string', enum: Object.keys(RESPONSE_ACTION) },
        comment: { type: 'string', description: 'A comment the organizer reads, with the answer.' },
        send_response: {
          type: 'boolean',
          description: 'Mail the answer to the organizer. Default false.',
        },
      },
      required: ['event_id', 'response'],
    },
  },
];
