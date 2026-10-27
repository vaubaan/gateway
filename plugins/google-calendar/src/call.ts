/**
 * The one reader of a `google-calendar` call, for `classify` and `execute`
 * alike.
 *
 * Handbook : docs/handbook/providers/google-calendar.md §2, §5.
 * ADR      : docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md ;
 *            docs/decisions/plugin-arguments-closed-surface-and-typed-refusals.md ;
 *            docs/decisions/google-calendar-through-an-oauth-broker.md D4.
 *
 * `readCalendarCall(tool, args, resources)` checks the tool, the closed
 * argument surface, the calendar (one of the mission), the event id through
 * its grammar, every attendee address, the type of every other argument, and
 * returns what to send — the upstream tool and its arguments, `calendarId`
 * written as the calendar's id — with what the classifier needs: the zones
 * of the people invited and whether Google will email the guests. Or the
 * sentence refusing the call. Pure: no network, no credential, no clock.
 */

import { declaredArgumentsOf, undeclaredArgumentDenial, type Resource } from '@vaubaan/plugin-sdk';

import { calendarIdOf, calendarRefFromArgument, eventId, parseAddress } from './identifiers.ts';
import {
  ATTENDEE_FIELDS,
  ATTENDEE_OBJECTS_ARGUMENT,
  CALENDAR_ARGUMENT,
  EVENT_ARGUMENT,
  LOCATOR,
  NO_NOTIFICATION,
  NOTIFICATION_ARGUMENT,
  PRIMARY_KEYWORD,
  PROVIDER_ID,
  TOOL,
  TOOL_PREFIX,
  UPSTREAM_TOOL,
} from './identity.ts';
import { googleCalendarTools, upstreamToolOf } from './tools.ts';

type Args = Readonly<Record<string, unknown>>;

/** Who a call invites, by zone. */
export type GuestZone = 'internal' | 'external';

export type CalendarCall =
  /** Answered by the gateway from the mission's calendars. */
  | { readonly kind: 'list-calendars'; readonly calendars: readonly Resource[] }
  | {
      readonly kind: 'forward';
      readonly tool: string;
      readonly upstream: string;
      /** The calendar ref, `null` for a tool that names no calendar. */
      readonly calendar: string | null;
      /** The event the call names, `null` when it names none. */
      readonly event: string | null;
      /** The zones of the people the call invites, each once. */
      readonly guests: readonly GuestZone[];
      /** Whether Google will email the event's current guests (a change or a deletion). */
      readonly notifiesGuests: boolean;
      /** What leaves for Google. */
      readonly arguments: Readonly<Record<string, unknown>>;
    };

export type CalendarCallOutcome = { readonly call: CalendarCall } | { readonly denied: string };

const DECLARATION_OF = new Map(googleCalendarTools.map((t) => [t.name, t] as const));
const DECLARED_ARGUMENTS = declaredArgumentsOf(googleCalendarTools);

export const NO_CALENDAR = 'no Google calendar in this mission';

/** Domains whose addresses are the company's own meeting rooms and resources. */
const RESOURCE_DOMAIN = 'resource.calendar.google.com';

/** The mission's Google calendars, in mission order. */
export function calendarsOf(resources: readonly Resource[]): Resource[] {
  return resources.filter((r) => r.provider === PROVIDER_ID);
}

/** The primary calendar of the mission, if it holds it (`metadata.primary`). */
function primaryOf(calendars: readonly Resource[]): Resource | undefined {
  return calendars.find((c) => c.metadata?.primary === true);
}

/** The calendar a `calendarId` argument names, when it is one of the mission's. */
export function resolveCalendar(
  value: unknown,
  resources: readonly Resource[],
): { readonly calendar: Resource } | { readonly denied: string } {
  const calendars = calendarsOf(resources);
  if (calendars.length === 0) return { denied: NO_CALENDAR };
  if (value === undefined || value === PRIMARY_KEYWORD) {
    const primary = primaryOf(calendars);
    return primary
      ? { calendar: primary }
      : {
          denied: `${CALENDAR_ARGUMENT}: the primary calendar is not in this mission; name one of its calendars (google_calendar__list_calendars).`,
        };
  }
  const ref = calendarRefFromArgument(value);
  if (ref === null) {
    return {
      denied: `${CALENDAR_ARGUMENT}: expected a calendar ref (alice~acme.com) or a calendar id (alice@acme.com).`,
    };
  }
  const calendar = calendars.find((c) => c.ref === ref);
  if (!calendar) {
    return { denied: `${CALENDAR_ARGUMENT}: calendar '${ref}' is not a calendar of this mission.` };
  }
  return { calendar };
}

/** The lists a calendar's zoning reads (owner-edited `metadata`). */
interface Zoning {
  readonly internalDomains: readonly string[];
  readonly accountEmail: string | null;
}

function zoningOf(calendar: Resource): Zoning {
  const md = calendar.metadata ?? {};
  const domains = Array.isArray(md.internal_domains)
    ? md.internal_domains
        .filter((d): d is string => typeof d === 'string')
        .map((d) => d.toLowerCase())
    : [];
  const account = typeof md.account_email === 'string' ? md.account_email.toLowerCase() : null;
  return { internalDomains: domains, accountEmail: account };
}

/**
 * The zone of one person: `null` for the account itself (inviting oneself
 * reaches nobody), `internal` for an internal domain of the calendar or a
 * meeting room, `external` otherwise.
 */
export function zoneOf(address: string, domain: string, zoning: Zoning): GuestZone | null {
  if (zoning.accountEmail !== null && address === zoning.accountEmail) return null;
  if (domain === RESOURCE_DOMAIN || domain.endsWith(`.${RESOURCE_DOMAIN}`)) return 'internal';
  return zoning.internalDomains.includes(domain) ? 'internal' : 'external';
}

/** The attendees of a create or an update: each an object with exactly one parseable `email`. */
function readAttendees(
  name: string,
  value: unknown,
  zoning: Zoning,
): { readonly attendees: unknown[]; readonly zones: Set<GuestZone> } | { readonly denied: string } {
  if (!Array.isArray(value)) return { denied: `${name}: expected a list of attendees.` };
  const zones = new Set<GuestZone>();
  const attendees: unknown[] = [];
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { denied: `${name}[${i}]: expected an attendee object { email }.` };
    }
    const attendee = raw as Record<string, unknown>;
    const extra = Object.keys(attendee).filter((k) => !ATTENDEE_FIELDS.has(k));
    if (extra.length > 0) {
      return {
        denied: `${name}[${i}]: ${extra.join(', ')} not accepted; an attendee is { email, displayName, optional }.`,
      };
    }
    const parsed = parseAddress(attendee.email);
    if (!parsed) return { denied: `${name}[${i}].email: expected exactly one email address.` };
    if (attendee.displayName !== undefined && typeof attendee.displayName !== 'string') {
      return { denied: `${name}[${i}].displayName: expected a string.` };
    }
    if (attendee.optional !== undefined && typeof attendee.optional !== 'boolean') {
      return { denied: `${name}[${i}].optional: expected true or false.` };
    }
    const zone = zoneOf(parsed.address, parsed.domain, zoning);
    if (zone) zones.add(zone);
    attendees.push({ ...attendee, email: parsed.address });
  }
  return { attendees, zones };
}

/** A list of addresses, each exactly one (`removedAttendeeEmails`, `attendeeEmails` of suggest_time). */
function readAddresses(name: string, value: unknown): string[] | { readonly denied: string } {
  if (!Array.isArray(value)) return { denied: `${name}: expected a list of email addresses.` };
  const out: string[] = [];
  for (const [i, raw] of value.entries()) {
    const parsed = parseAddress(raw);
    if (!parsed) return { denied: `${name}[${i}]: expected exactly one email address.` };
    out.push(parsed.address);
  }
  return out;
}

/** The JSON type an argument's schema names, checked loosely, and its enum when it has one. */
function typeIssue(name: string, schema: unknown, value: unknown): string | null {
  const declared = schema as { readonly type?: unknown; readonly enum?: unknown } | null;
  const type = declared?.type;
  const ok = (() => {
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      default:
        return true;
    }
  })();
  if (!ok) return `${name}: expected ${String(type)}.`;
  if (Array.isArray(declared?.enum) && !declared.enum.includes(value)) {
    return `${name}: expected one of ${declared.enum.join(', ')}.`;
  }
  return null;
}

/** The one reader of a call. Every refusal is a sentence the agent can act on. */
export function readCalendarCall(
  tool: string,
  args: Args,
  resources: readonly Resource[],
): CalendarCallOutcome {
  const declaration = DECLARATION_OF.get(tool);
  if (!declaration) return { denied: `unknown tool '${tool}'` };
  const undeclared = undeclaredArgumentDenial(DECLARED_ARGUMENTS, tool, args);
  if (undeclared !== null) return { denied: undeclared };

  if (tool === TOOL.listCalendars) {
    const calendars = calendarsOf(resources);
    if (calendars.length === 0) return { denied: NO_CALENDAR };
    return { call: { kind: 'list-calendars', calendars } };
  }

  const upstream = tool.slice(TOOL_PREFIX.length);
  const locator = LOCATOR[upstream];
  if (!upstreamToolOf(tool) || !locator) return { denied: `unknown tool '${tool}'` };

  let calendar: Resource | null = null;
  if (locator !== 'none') {
    const resolved = resolveCalendar(
      locator === 'primary' ? undefined : args[CALENDAR_ARGUMENT],
      resources,
    );
    if ('denied' in resolved) return resolved;
    calendar = resolved.calendar;
  }
  const zoning = calendar ? zoningOf(calendar) : { internalDomains: [], accountEmail: null };

  const forwarded: Record<string, unknown> = {};
  let event: string | null = null;
  const guests = new Set<GuestZone>();
  for (const [name, schema] of Object.entries(declaration.inputSchema.properties ?? {})) {
    const value = args[name];
    if (value === undefined) {
      if (declaration.inputSchema.required?.includes(name)) {
        return { denied: `${name}: required by '${tool}'.` };
      }
      continue;
    }
    if (name === CALENDAR_ARGUMENT) continue;
    if (name === EVENT_ARGUMENT) {
      event = eventId(value);
      if (event === null) return { denied: `${EVENT_ARGUMENT}: expected a Google event id.` };
    }
    if (name === ATTENDEE_OBJECTS_ARGUMENT[upstream]) {
      const read = readAttendees(name, value, zoning);
      if ('denied' in read) return read;
      read.zones.forEach((z) => guests.add(z));
      forwarded[name] = read.attendees;
      continue;
    }
    if (name === 'removedAttendeeEmails' || name === 'attendeeEmails') {
      const read = readAddresses(name, value);
      if (!Array.isArray(read)) return read;
      forwarded[name] = read;
      continue;
    }
    const issue = typeIssue(name, schema, value);
    if (issue !== null) return { denied: issue };
    forwarded[name] = value;
  }
  if (calendar !== null && locator === 'calendar') {
    const id = calendarIdOf(calendar.ref);
    if (id === null) return { denied: `${CALENDAR_ARGUMENT}: the calendar ref is malformed.` };
    forwarded[CALENDAR_ARGUMENT] = id;
  }

  const changesOrDeletes =
    upstream === UPSTREAM_TOOL.updateEvent || upstream === UPSTREAM_TOOL.deleteEvent;
  const notifiesGuests = changesOrDeletes && args[NOTIFICATION_ARGUMENT] !== NO_NOTIFICATION;

  return {
    call: {
      kind: 'forward',
      tool,
      upstream,
      calendar: calendar?.ref ?? null,
      event,
      guests: [...guests].sort(),
      notifiesGuests,
      arguments: forwarded,
    },
  };
}
