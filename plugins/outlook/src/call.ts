/**
 * The one reader of an `outlook` call, for `classify` and `execute` alike.
 *
 * Handbook : docs/handbook/services/outlook.md.
 * ADR      : docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md.
 *
 * `readOutlookCall(tool, args, resources)` checks the tool, the closed
 * argument surface, the mailbox (one of the mission), every identifier
 * through its grammar, every address, the type, enum and bounds of every
 * other argument and the rules that tie arguments together; it returns what
 * the executor sends — the values it read — with what the classifier needs:
 * the zones of senders, recipients and attendees. Or the sentence refusing
 * the call. Pure: no network, no credential, no clock.
 */

import {
  declaredArgumentsOf,
  undeclaredArgumentDenial,
  type McpToolDeclaration,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { addressList, parseAddress, type EmailAddress } from './address.ts';
import {
  folderRef,
  freeText,
  graphId,
  instantOf,
  localDateTime,
  mailboxRefOf,
  timeZoneName,
} from './identifiers.ts';
import {
  CALENDAR_ARGUMENT,
  CALENDAR_TOOLS,
  DEFAULT_CALENDAR,
  DRAFTS_FOLDER,
  MAILBOX_ARGUMENT,
  NO_MOVE_FOLDERS,
  SERVICE_ID,
  TOOL,
  TOOL_PREFIX,
} from './identity.ts';
import { parseQuery, type ParsedQuery } from './q-parser.ts';
import {
  MAX_ATTENDEES,
  MAX_CATEGORIES,
  MAX_FREE_BUSY_PEOPLE,
  MAX_SEND_RECIPIENTS,
  outlookTools,
} from './tools.ts';
import {
  fromZoneOf,
  guestZoneOf,
  readMailboxMetadata,
  worstToZone,
  type FromZone,
  type GuestZone,
  type MailboxMetadata,
  type ToZone,
} from './zones.ts';

type Args = Readonly<Record<string, unknown>>;

/** The recipients of a draft or a send, lower-cased, each list deduplicated. */
export interface Recipients {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}

/** A start or an end as Graph's dateTimeTimeZone. */
export interface GraphTime {
  readonly dateTime: string;
  readonly timeZone: string;
}

export interface OutlookCall {
  readonly tool: string;
  /** The tool name without its prefix (`get_message`). */
  readonly bare: string;
  /** The mailbox of the mission the call acts on, and its zoning. */
  readonly mailbox: Resource;
  readonly zoning: MailboxMetadata;
  readonly messageId: string | null;
  readonly attachmentId: string | null;
  readonly draftId: string | null;
  /** The folder searched, or the destination of a move: a well-known name or an id. */
  readonly folder: string | null;
  /** The folder whose children are listed, or under which a folder is created. */
  readonly parent: string | null;
  /** `default` or a calendar id, for a tool that names a calendar; `null` otherwise. */
  readonly calendar: string | null;
  readonly eventId: string | null;
  /** The parsed query of `search_messages`. */
  readonly query: ParsedQuery | null;
  /** The sender zones a read reveals, each once. */
  readonly fromZones: readonly FromZone[];
  /** A search not bounded by exactly one sender. */
  readonly bulk: boolean;
  /** A search of the Drafts folder. */
  readonly readsDrafts: boolean;
  readonly recipients: Recipients | null;
  /** The worst recipient zone of a draft (never `external-unbounded`: refused). */
  readonly draftZone: ToZone | null;
  /** The worst recipient zone of a send. */
  readonly sendZone: ToZone | null;
  /** The attendees a create invites or an update adds, lower-cased. */
  readonly attendees: readonly string[];
  readonly removedAttendees: readonly string[];
  /** The zones of the people invited, each once. */
  readonly guests: readonly GuestZone[];
  /** The other arguments read: text, booleans, integers, times as Graph takes them. */
  readonly values: Readonly<Record<string, unknown>>;
  /** The start and end of an event write, when given. */
  readonly start: GraphTime | null;
  readonly end: GraphTime | null;
  /** The instants of a time range (`list_events`, `search_events`, `suggest_time`), ms. */
  readonly range: { readonly start: number; readonly end: number } | null;
}

export type OutlookCallOutcome = { readonly call: OutlookCall } | { readonly denied: string };

const DECLARATION_OF = new Map(outlookTools.map((t) => [t.name, t] as const));
const DECLARED_ARGUMENTS = declaredArgumentsOf(outlookTools);

export const NO_MAILBOX = 'no Outlook mailbox is a resource of this mission.';

/** Bounds of the text an agent writes. */
const MAX_SUBJECT = 255;
const MAX_BODY = 1_000_000;
const MAX_SHORT_TEXT = 255;
const MAX_COMMENT = 10_000;

/** The mission's Outlook mailboxes. */
export function mailboxesOf(resources: readonly Resource[]): Resource[] {
  return resources.filter((r) => r.service === SERVICE_ID);
}

/** The mailbox a `mailbox` argument names, when it is one of the mission's. */
export function resolveMailbox(
  value: unknown,
  resources: readonly Resource[],
): { readonly mailbox: Resource } | { readonly denied: string } {
  const mailboxes = mailboxesOf(resources);
  if (mailboxes.length === 0) return { denied: NO_MAILBOX };
  if (value === undefined) {
    const [only] = mailboxes;
    if (mailboxes.length === 1 && only !== undefined) return { mailbox: only };
    return { denied: `${MAILBOX_ARGUMENT}: this mission has several mailboxes; name one.` };
  }
  if (typeof value !== 'string') return { denied: `${MAILBOX_ARGUMENT}: expected a string.` };
  let ref = value;
  if (value.includes('@')) {
    const address = parseAddress(value);
    if (address === null) {
      return { denied: `${MAILBOX_ARGUMENT}: expected a mailbox ref or exactly one address.` };
    }
    ref = mailboxRefOf(address.address);
  }
  const mailbox = mailboxes.find((m) => m.ref === ref);
  if (!mailbox) {
    return {
      denied: `${MAILBOX_ARGUMENT}: '${ref.slice(0, 80)}' is not a mailbox of this mission.`,
    };
  }
  return { mailbox };
}

// ─── Schema checks ───────────────────────────────────────────────────────────

interface ArgumentSchema {
  readonly type?: unknown;
  readonly enum?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly items?: { readonly type?: unknown };
}

function hasType(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}

/** The JSON type, enum, integer bounds and item type a schema names, checked. */
function typeIssue(name: string, schema: ArgumentSchema, value: unknown): string | null {
  if (!hasType(schema.type, value)) return `${name}: expected ${String(schema.type)}.`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${name}: expected one of ${schema.enum.join(', ')}.`;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return `${name}: at least ${schema.minimum}.`;
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return `${name}: at most ${schema.maximum}.`;
    }
  }
  if (Array.isArray(value) && schema.items?.type !== undefined) {
    const bad = value.findIndex((v) => !hasType(schema.items?.type, v));
    if (bad >= 0) return `${name}[${bad}]: expected ${String(schema.items.type)}.`;
  }
  return null;
}

/** Every argument given has its schema's type; every required one is given. */
function schemaIssue(declaration: McpToolDeclaration, args: Args): string | null {
  const properties = declaration.inputSchema.properties ?? {};
  for (const name of declaration.inputSchema.required ?? []) {
    if (args[name] === undefined) return `${name}: required by '${declaration.name}'.`;
  }
  for (const [name, schema] of Object.entries(properties)) {
    const value = args[name];
    if (value === undefined) continue;
    const issue = typeIssue(name, schema as ArgumentSchema, value);
    if (issue !== null) return issue;
  }
  return null;
}

// ─── Readers of one kind of argument ─────────────────────────────────────────

type Read<T> = { readonly value: T } | { readonly denied: string };

function denied(text: string): { readonly denied: string } {
  return { denied: text };
}

function idOf(args: Args, name: string): Read<string | null> {
  if (args[name] === undefined) return { value: null };
  const id = graphId(args[name]);
  return id === null
    ? denied(`${name}: expected a Graph id (letters, digits, + = _ -).`)
    : { value: id };
}

function folderOf(args: Args, name: string): Read<string | null> {
  if (args[name] === undefined) return { value: null };
  const folder = folderRef(args[name]);
  return folder === null
    ? denied(`${name}: expected a well-known folder name (inbox, archive…) or a folder id.`)
    : { value: folder };
}

function textOf(args: Args, name: string, max: number, lines: boolean): Read<string | null> {
  if (args[name] === undefined) return { value: null };
  const text = freeText(args[name], max, lines);
  return text === null
    ? denied(
        `${name}: at most ${max} characters, no control character${lines ? '' : ' or line break'}.`,
      )
    : { value: text };
}

function addressesOf(args: Args, name: string): Read<readonly EmailAddress[]> {
  if (args[name] === undefined) return { value: [] };
  const list = addressList(name, args[name]);
  return 'denied' in list ? list : { value: list };
}

function recipientsOf(
  args: Args,
): Read<{ readonly all: readonly EmailAddress[]; readonly lists: Recipients }> {
  const lists: Record<'to' | 'cc' | 'bcc', string[]> = { to: [], cc: [], bcc: [] };
  const all: EmailAddress[] = [];
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const read = addressesOf(args, field);
    if ('denied' in read) return read;
    lists[field] = read.value.map((a) => a.address);
    all.push(...read.value);
  }
  if (all.length > MAX_SEND_RECIPIENTS) {
    return denied(`to, cc, bcc: at most ${MAX_SEND_RECIPIENTS} recipients together.`);
  }
  return { value: { all, lists } };
}

function calendarOf(args: Args): Read<string> {
  const value = args[CALENDAR_ARGUMENT];
  if (value === undefined || value === DEFAULT_CALENDAR) return { value: DEFAULT_CALENDAR };
  const id = graphId(value);
  return id === null
    ? denied(
        `${CALENDAR_ARGUMENT}: expected "default" or a calendar id from outlook__list_calendars.`,
      )
    : { value: id };
}

/** The time range of a read: both instants with an offset, end after start. */
function rangeOf(args: Args, optional: boolean): Read<{ start: number; end: number } | null> {
  if (optional && args.start === undefined && args.end === undefined) return { value: null };
  const start = instantOf(args.start);
  const end = instantOf(args.end);
  if (start === null || end === null) {
    return denied(
      'start, end: give both, RFC 3339 instants with an offset (2026-11-05T09:00:00Z).',
    );
  }
  if (end <= start) return denied('end: must be after start.');
  return { value: { start, end } };
}

/** UTC as Graph's dateTime: no offset, no fraction. */
function utcDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/**
 * The start and end of an event write. With `time_zone`, both are local
 * date-times of that zone; without, both are RFC 3339 instants, sent as UTC.
 */
function eventTimesOf(
  args: Args,
  required: boolean,
): Read<{ start: GraphTime; end: GraphTime } | null> {
  const given = args.start !== undefined || args.end !== undefined;
  if (!given) {
    if (required) return denied('start, end: required.');
    if (args.time_zone !== undefined) return denied('time_zone: give start and end with it.');
    return { value: null };
  }
  if (args.start === undefined || args.end === undefined) {
    return denied('start, end: give both or neither.');
  }
  if (args.time_zone !== undefined) {
    const zone = timeZoneName(args.time_zone);
    if (zone === null) return denied('time_zone: expected a Windows or IANA time zone name.');
    const start = localDateTime(args.start);
    const end = localDateTime(args.end);
    if (start === null || end === null) {
      return denied('start, end: local date-times (2026-11-05T10:00) when time_zone is given.');
    }
    if (end <= start) return denied('end: must be after start.');
    return {
      value: { start: { dateTime: start, timeZone: zone }, end: { dateTime: end, timeZone: zone } },
    };
  }
  const start = instantOf(args.start);
  const end = instantOf(args.end);
  if (start === null || end === null) {
    return denied(
      'start, end: RFC 3339 instants with an offset, or local date-times with time_zone.',
    );
  }
  if (end <= start) return denied('end: must be after start.');
  return {
    value: {
      start: { dateTime: utcDateTime(start), timeZone: 'UTC' },
      end: { dateTime: utcDateTime(end), timeZone: 'UTC' },
    },
  };
}

// ─── The reader ──────────────────────────────────────────────────────────────

interface Draft {
  messageId: string | null;
  attachmentId: string | null;
  draftId: string | null;
  folder: string | null;
  parent: string | null;
  calendar: string | null;
  eventId: string | null;
  query: ParsedQuery | null;
  fromZones: FromZone[];
  bulk: boolean;
  readsDrafts: boolean;
  recipients: Recipients | null;
  draftZone: ToZone | null;
  sendZone: ToZone | null;
  attendees: string[];
  removedAttendees: string[];
  guests: GuestZone[];
  values: Record<string, unknown>;
  start: GraphTime | null;
  end: GraphTime | null;
  range: { start: number; end: number } | null;
}

function emptyDraft(): Draft {
  return {
    messageId: null,
    attachmentId: null,
    draftId: null,
    folder: null,
    parent: null,
    calendar: null,
    eventId: null,
    query: null,
    fromZones: [],
    bulk: false,
    readsDrafts: false,
    recipients: null,
    draftZone: null,
    sendZone: null,
    attendees: [],
    removedAttendees: [],
    guests: [],
    values: {},
    start: null,
    end: null,
    range: null,
  };
}

/** The one reader of a call. Every refusal is a sentence the agent can act on. */
export function readOutlookCall(
  tool: string,
  args: Args,
  resources: readonly Resource[],
): OutlookCallOutcome {
  const declaration = DECLARATION_OF.get(tool);
  if (!declaration) return { denied: `unknown tool '${tool}'` };
  const undeclared = undeclaredArgumentDenial(DECLARED_ARGUMENTS, tool, args);
  if (undeclared !== null) return { denied: undeclared };
  const resolved = resolveMailbox(args[MAILBOX_ARGUMENT], resources);
  if ('denied' in resolved) return resolved;
  const schema = schemaIssue(declaration, args);
  if (schema !== null) return { denied: schema };

  const zoning = readMailboxMetadata(resolved.mailbox);
  const d = emptyDraft();
  const issue = CALENDAR_TOOLS.has(tool)
    ? readCalendar(tool, args, zoning, d)
    : readMail(tool, args, zoning, d);
  if (issue !== null) return { denied: issue };
  return {
    call: {
      tool,
      bare: tool.slice(TOOL_PREFIX.length),
      mailbox: resolved.mailbox,
      zoning,
      ...d,
      fromZones: [...new Set(d.fromZones)],
      guests: [...new Set(d.guests)].sort(),
    },
  };
}

/** Assigns a read value to the draft, or returns the refusal. */
function take<T>(read: Read<T>, set: (value: T) => void): string | null {
  if ('denied' in read) return read.denied;
  set(read.value);
  return null;
}

function readMail(tool: string, args: Args, zoning: MailboxMetadata, d: Draft): string | null {
  const messageId = (): string | null =>
    take(idOf(args, 'message_id'), (v) => {
      d.messageId = v;
    });
  switch (tool) {
    case TOOL.describeZones:
    case TOOL.listDrafts:
      if (typeof args.top === 'number') d.values.top = args.top;
      return null;

    case TOOL.listFolders:
      return take(folderOf(args, 'parent'), (v) => {
        d.parent = v;
      });

    case TOOL.searchMessages: {
      const parsed = parseQuery(args.query);
      if ('denied' in parsed) return parsed.denied;
      d.query = parsed.query;
      const folder = take(folderOf(args, 'folder'), (v) => {
        d.folder = v;
      });
      if (folder !== null) return folder;
      if (typeof args.top === 'number') d.values.top = args.top;
      // Bounded: exactly one sender, every message returned is from them (filtered
      // by Graph, or after a full-text search by the executor).
      const [only] = parsed.query.from;
      const sender =
        parsed.query.from.length === 1 && only !== undefined ? parseAddress(only) : null;
      if (sender !== null) {
        d.fromZones.push(fromZoneOf(sender, zoning));
      } else {
        d.fromZones.push('unknown');
        d.bulk = true;
      }
      d.readsDrafts = d.folder === DRAFTS_FOLDER;
      return null;
    }

    case TOOL.getMessage:
    case TOOL.listAttachments: {
      const issue = messageId();
      if (issue !== null) return issue;
      d.fromZones.push('unknown');
      return null;
    }

    case TOOL.getAttachment: {
      const issue =
        messageId() ??
        take(idOf(args, 'attachment_id'), (v) => {
          d.attachmentId = v;
        });
      if (issue !== null) return issue;
      d.fromZones.push('unknown');
      return null;
    }

    case TOOL.createDraft:
    case TOOL.createReplyDraft:
      return (
        readDraftWrite(tool, args, zoning, d) ??
        (tool === TOOL.createReplyDraft ? messageId() : null)
      );

    case TOOL.sendMessage:
    case TOOL.sendDraft: {
      if (tool === TOOL.sendDraft) {
        const issue = take(idOf(args, 'draft_id'), (v) => {
          d.draftId = v;
        });
        if (issue !== null) return issue;
      } else {
        const issue = readSubjectAndBody(args, d);
        if (issue !== null) return issue;
      }
      const read = recipientsOf(args);
      if ('denied' in read) return read.denied;
      if (read.value.all.length === 0)
        return 'a send needs at least one recipient in to, cc or bcc.';
      d.recipients = read.value.lists;
      d.sendZone = worstToZone(read.value.all, zoning);
      return null;
    }

    case TOOL.moveMessage: {
      const issue =
        messageId() ??
        take(folderOf(args, 'folder'), (v) => {
          d.folder = v;
        });
      if (issue !== null) return issue;
      if (d.folder !== null && NO_MOVE_FOLDERS.has(d.folder)) {
        return `folder: '${d.folder}' deletes or sends mail; a move there is not offered.`;
      }
      return null;
    }

    case TOOL.updateMessage: {
      const issue = messageId();
      if (issue !== null) return issue;
      if (args.is_read === undefined && args.flag === undefined && args.categories === undefined) {
        return 'give is_read, flag or categories.';
      }
      if (typeof args.is_read === 'boolean') d.values.is_read = args.is_read;
      if (typeof args.flag === 'string') d.values.flag = args.flag;
      if (Array.isArray(args.categories)) {
        if (args.categories.length > MAX_CATEGORIES)
          return `categories: at most ${MAX_CATEGORIES}.`;
        const categories: string[] = [];
        for (const [i, c] of args.categories.entries()) {
          const text = freeText(c, MAX_SHORT_TEXT, false);
          if (text === null || text.trim() === '') {
            return `categories[${i}]: 1 to ${MAX_SHORT_TEXT} characters, no control character.`;
          }
          categories.push(text);
        }
        d.values.categories = categories;
      }
      return null;
    }

    case TOOL.createFolder: {
      const issue =
        take(folderOf(args, 'parent'), (v) => {
          d.parent = v;
        }) ??
        take(textOf(args, 'name', MAX_SHORT_TEXT, false), (v) => {
          d.values.name = v;
        });
      if (issue !== null) return issue;
      if (typeof d.values.name !== 'string' || d.values.name.trim() === '') {
        return 'name: 1 to 255 characters.';
      }
      return null;
    }

    default:
      return `unknown tool '${tool}'`;
  }
}

function readSubjectAndBody(args: Args, d: Draft): string | null {
  return (
    take(textOf(args, 'subject', MAX_SUBJECT, false), (v) => {
      if (v !== null) d.values.subject = v;
    }) ??
    take(textOf(args, 'body', MAX_BODY, true), (v) => {
      if (v !== null) d.values.body = v;
    })
  );
}

/** A draft or a reply draft: its text and its recipients, zoned; outside the allowlists refused. */
function readDraftWrite(
  tool: string,
  args: Args,
  zoning: MailboxMetadata,
  d: Draft,
): string | null {
  const text =
    tool === TOOL.createReplyDraft
      ? take(textOf(args, 'body', MAX_BODY, true), (v) => {
          if (v !== null) d.values.body = v;
        })
      : readSubjectAndBody(args, d);
  if (text !== null) return text;
  const read = recipientsOf(args);
  if ('denied' in read) return read.denied;
  if (tool === TOOL.createReplyDraft) {
    if (read.value.lists.to.length === 0) return 'to: a reply draft names at least one recipient.';
    d.values.reply_all = args.reply_all === true;
  }
  const zone = worstToZone(read.value.all, zoning);
  // The exfiltration vector of a draft: refused here, since no permission can be
  // unacceptable to every mission.
  if (zone === 'external-unbounded') {
    return 'recipients outside the internal domains and the allowlists: not acceptable for a draft.';
  }
  d.recipients = read.value.lists;
  d.draftZone = zone;
  return null;
}

/** The people of a create or an update, zoned. */
function readAttendees(name: string, args: Args, zoning: MailboxMetadata, d: Draft): string | null {
  const read = addressesOf(args, name);
  if ('denied' in read) return read.denied;
  if (read.value.length > MAX_ATTENDEES) return `${name}: at most ${MAX_ATTENDEES}.`;
  for (const person of read.value) {
    const zone = guestZoneOf(person, zoning);
    if (zone !== null) d.guests.push(zone);
  }
  d.attendees = read.value.map((a) => a.address);
  return null;
}

function readEventText(args: Args, d: Draft): string | null {
  return (
    take(textOf(args, 'subject', MAX_SUBJECT, false), (v) => {
      if (v !== null) d.values.subject = v;
    }) ??
    take(textOf(args, 'body', MAX_BODY, true), (v) => {
      if (v !== null) d.values.body = v;
    }) ??
    take(textOf(args, 'location', MAX_SHORT_TEXT, false), (v) => {
      if (v !== null) d.values.location = v;
    })
  );
}

function readCalendar(tool: string, args: Args, zoning: MailboxMetadata, d: Draft): string | null {
  if (tool === TOOL.listCalendars) return null;
  if (tool === TOOL.suggestTime) {
    const people = addressesOf(args, 'attendees');
    if ('denied' in people) return people.denied;
    const others = people.value.filter((p) => p.address !== zoning.account_email);
    if (people.value.length === 0 || others.length > MAX_FREE_BUSY_PEOPLE) {
      return `attendees: 1 to ${MAX_FREE_BUSY_PEOPLE} addresses besides this account (always included).`;
    }
    d.attendees = others.map((p) => p.address);
    for (const name of ['duration_minutes', 'max_suggestions'] as const) {
      if (typeof args[name] === 'number') d.values[name] = args[name];
    }
    return take(rangeOf(args, false), (v) => {
      d.range = v;
    });
  }

  const calendar = take(calendarOf(args), (v) => {
    d.calendar = v;
  });
  if (calendar !== null) return calendar;
  const event = take(idOf(args, 'event_id'), (v) => {
    d.eventId = v;
  });
  if (event !== null) return event;
  if (typeof args.top === 'number') d.values.top = args.top;

  switch (tool) {
    case TOOL.listEvents:
      return take(rangeOf(args, false), (v) => {
        d.range = v;
      });
    case TOOL.searchEvents: {
      const text = freeText(args.text, MAX_SHORT_TEXT, false);
      if (text === null || text.trim() === '')
        return 'text: 1 to 255 characters, no control character.';
      d.values.text = text;
      return take(rangeOf(args, true), (v) => {
        d.range = v;
      });
    }
    case TOOL.getEvent:
    case TOOL.deleteEvent:
      return null;
    case TOOL.createEvent:
      return (
        readEventText(args, d) ??
        take(eventTimesOf(args, true), (v) => {
          d.start = v?.start ?? null;
          d.end = v?.end ?? null;
        }) ??
        readAttendees('attendees', args, zoning, d)
      );
    case TOOL.updateEvent: {
      const issue =
        readEventText(args, d) ??
        take(eventTimesOf(args, false), (v) => {
          d.start = v?.start ?? null;
          d.end = v?.end ?? null;
        }) ??
        readAttendees('added_attendees', args, zoning, d);
      if (issue !== null) return issue;
      const removed = addressesOf(args, 'removed_attendee_emails');
      if ('denied' in removed) return removed.denied;
      d.removedAttendees = removed.value.map((a) => a.address);
      const changes =
        Object.keys(d.values).filter((k) => k !== 'top').length +
        (d.start !== null ? 1 : 0) +
        d.attendees.length +
        d.removedAttendees.length;
      return changes === 0 ? 'nothing to change: give a field, a time or attendees.' : null;
    }
    case TOOL.respondToEvent: {
      d.values.response = args.response;
      d.values.send_response = args.send_response === true;
      return take(textOf(args, 'comment', MAX_COMMENT, true), (v) => {
        if (v !== null) d.values.comment = v;
      });
    }
    default:
      return `unknown tool '${tool}'`;
  }
}
