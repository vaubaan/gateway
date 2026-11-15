/**
 * Identity of the `outlook` service — the one place its ids and Microsoft
 * Graph's own names are written.
 *
 * Handbook : docs/handbook/services/outlook.md.
 * ADR      : docs/decisions/outlook-through-the-oauth-broker-microsoft-provider.md.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. The tool prefix is the
 * SDK's rule (`toolPrefixFor`): `outlook__`.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

export const SERVICE_ID = 'outlook';

/** `outlook__` : prepended to the bare tool names. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/**
 * Microsoft Graph v1.0 ("Use the Microsoft Graph API", read 2026-11-05):
 * every path of the reference is relative to it; a Microsoft access token
 * authenticates as a Bearer.
 */
export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

/** The broker provider whose OAuth client the access token is issued to. */
export const BROKER_PROVIDER = 'microsoft';

/**
 * The scopes asked. `offline_access` is what makes Microsoft issue a refresh
 * token; `openid`, `email` and `profile` let the ID token name the account.
 * The four Graph permissions are delegated ones, none needing an
 * administrator's consent ("Microsoft Graph permissions reference").
 */
export const SCOPES = {
  openid: 'openid',
  email: 'email',
  profile: 'profile',
  offlineAccess: 'offline_access',
  userRead: 'User.Read',
  mailReadWrite: 'Mail.ReadWrite',
  mailSend: 'Mail.Send',
  calendarsReadWrite: 'Calendars.ReadWrite',
} as const;

/** The tool names without the prefix: 14 for mail, 9 for the calendar. */
export const BARE_TOOL = {
  describeZones: 'describe_zones',
  listFolders: 'list_folders',
  searchMessages: 'search_messages',
  getMessage: 'get_message',
  listAttachments: 'list_attachments',
  getAttachment: 'get_attachment',
  listDrafts: 'list_drafts',
  createDraft: 'create_draft',
  createReplyDraft: 'create_reply_draft',
  sendMessage: 'send_message',
  sendDraft: 'send_draft',
  moveMessage: 'move_message',
  updateMessage: 'update_message',
  createFolder: 'create_folder',
  listCalendars: 'list_calendars',
  listEvents: 'list_events',
  searchEvents: 'search_events',
  getEvent: 'get_event',
  suggestTime: 'suggest_time',
  createEvent: 'create_event',
  updateEvent: 'update_event',
  deleteEvent: 'delete_event',
  respondToEvent: 'respond_to_event',
} as const;

export type BareToolName = (typeof BARE_TOOL)[keyof typeof BARE_TOOL];

/** The gateway's name of a bare tool name. */
export function toolNameOf(bare: string): string {
  return `${TOOL_PREFIX}${bare}`;
}

/** The MCP tool names of the plugin, in the order `tools/list` gives them. */
export const TOOL = {
  describeZones: toolNameOf(BARE_TOOL.describeZones),
  listFolders: toolNameOf(BARE_TOOL.listFolders),
  searchMessages: toolNameOf(BARE_TOOL.searchMessages),
  getMessage: toolNameOf(BARE_TOOL.getMessage),
  listAttachments: toolNameOf(BARE_TOOL.listAttachments),
  getAttachment: toolNameOf(BARE_TOOL.getAttachment),
  listDrafts: toolNameOf(BARE_TOOL.listDrafts),
  createDraft: toolNameOf(BARE_TOOL.createDraft),
  createReplyDraft: toolNameOf(BARE_TOOL.createReplyDraft),
  sendMessage: toolNameOf(BARE_TOOL.sendMessage),
  sendDraft: toolNameOf(BARE_TOOL.sendDraft),
  moveMessage: toolNameOf(BARE_TOOL.moveMessage),
  updateMessage: toolNameOf(BARE_TOOL.updateMessage),
  createFolder: toolNameOf(BARE_TOOL.createFolder),
  listCalendars: toolNameOf(BARE_TOOL.listCalendars),
  listEvents: toolNameOf(BARE_TOOL.listEvents),
  searchEvents: toolNameOf(BARE_TOOL.searchEvents),
  getEvent: toolNameOf(BARE_TOOL.getEvent),
  suggestTime: toolNameOf(BARE_TOOL.suggestTime),
  createEvent: toolNameOf(BARE_TOOL.createEvent),
  updateEvent: toolNameOf(BARE_TOOL.updateEvent),
  deleteEvent: toolNameOf(BARE_TOOL.deleteEvent),
  respondToEvent: toolNameOf(BARE_TOOL.respondToEvent),
} as const;

/**
 * Tools of Outlook the plugin deliberately leaves out (handbook
 * services/outlook.md, "Tools deliberately left out"), each with the sentence
 * its public page shows: declared nowhere, so `classify` refuses each as an
 * unknown tool, and the plugin's `excludedTools`.
 */
export const EXCLUDED_TOOLS: Readonly<Record<string, string>> = {
  [toolNameOf('delete_message')]:
    'No deletion of mail is offered, not even a move to Deleted Items; tidying stops at moving a message between folders.',
  [toolNameOf('forward_message')]:
    "Forwarding sends a message's content at once to recipients unknown before the call; the agent writes a draft and sends it with send_draft instead.",
  [toolNameOf('reply_message')]:
    'Replying sends at once to whoever the original names, unknown before the call; the agent writes a reply draft and sends it with send_draft instead.',
  [toolNameOf('reply_all_message')]:
    'Replying to all sends at once to every recipient of the original, unknown before the call; the agent writes a reply draft and sends it with send_draft instead.',
};

/** The tools of the `calendar` and `free-busy` side; every other tool is mail. */
export const CALENDAR_TOOLS: ReadonlySet<string> = new Set([
  TOOL.listCalendars,
  TOOL.listEvents,
  TOOL.searchEvents,
  TOOL.getEvent,
  TOOL.suggestTime,
  TOOL.createEvent,
  TOOL.updateEvent,
  TOOL.deleteEvent,
  TOOL.respondToEvent,
]);

/** The argument every tool takes to name the mailbox (the account); the single one when omitted. */
export const MAILBOX_ARGUMENT = 'mailbox';
/** The argument of the calendar tools that names a calendar; the default one when omitted. */
export const CALENDAR_ARGUMENT = 'calendar';
/** The calendar keyword for the account's default calendar (`/me/calendar`). */
export const DEFAULT_CALENDAR = 'default';

/**
 * `Prefer` values ("Get immutable identifiers for Outlook resources";
 * "Send Outlook messages", read 2026-11-05). Immutable ids do not change
 * when a message moves to another folder; the header applies to the request
 * it is sent with, so it is sent with every request. Message reads ask for a
 * text body: HTML from a sender never reaches the agent as HTML.
 */
export const PREFER_IMMUTABLE_ID = 'IdType="ImmutableId"';
export const PREFER_TEXT_BODY = 'outlook.body-content-type="text"';
export const PREFER_UTC = 'outlook.timezone="UTC"';

/**
 * The well-known folder names of the mailFolder resource (Graph v1.0
 * reference, read 2026-11-05). They work whatever the mailbox's language.
 */
export const WELL_KNOWN_FOLDERS = [
  'archive',
  'clutter',
  'conflicts',
  'conversationhistory',
  'deleteditems',
  'drafts',
  'inbox',
  'junkemail',
  'localfailures',
  'msgfolderroot',
  'outbox',
  'recoverableitemsdeletions',
  'scheduled',
  'searchfolders',
  'sentitems',
  'serverfailures',
  'syncissues',
] as const;

/**
 * Folders a move may not reach: a move there is a deletion (`deleteditems`,
 * `recoverableitemsdeletions`), a report as junk (`junkemail`), or puts a
 * message where Outlook sends from (`outbox`). A folder under one of them is
 * refused too (`execute`).
 */
export const NO_MOVE_FOLDERS: ReadonlySet<string> = new Set([
  'deleteditems',
  'recoverableitemsdeletions',
  'junkemail',
  'outbox',
]);

/** The drafts folder (`list_drafts`, and a search there reads drafts). */
export const DRAFTS_FOLDER = 'drafts';

/** The answers to an invitation and Graph's action for each (event: accept, tentativelyAccept, decline). */
export const RESPONSE_ACTION = {
  accept: 'accept',
  tentative: 'tentativelyAccept',
  decline: 'decline',
} as const;
export type ResponseKind = keyof typeof RESPONSE_ACTION;

/** The follow-up flag states a message update may set (followupFlag.flagStatus). */
export const FLAG_STATUSES = ['notFlagged', 'flagged', 'complete'] as const;
