/**
 * Verification, resource discovery and execution of the `caldav` provider.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §2.4, §5, §7.2.
 * ADR      : docs/decisions/google-calendar-through-an-oauth-broker.md (D5) ;
 *            docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md.
 * Handbook : docs/handbook/providers/caldav.md, "Discovery" and "Execution".
 *
 * Everything goes through `ctx.fetch` (`dav.ts`), signed with the account's
 * app password, to the server the person typed or a sibling host of it.
 *
 *   - **Discovery** (RFC 6764, RFC 5397, RFC 4791 §6.2) : `PROPFIND` of
 *     `current-user-principal` — at `/.well-known/caldav` first when the URL
 *     is a bare host, redirects followed by the plugin through the same host
 *     check —, then of the principal's `calendar-home-set` and
 *     `calendar-user-address-set`, then of the home's children at depth 1.
 *     Each collection that is a calendar and stores `VEVENT` is a resource.
 *   - **Execution** : the target calendar is the classifier's
 *     (`resolveCalendar`), its address read from the resource and checked
 *     again ; the event id and the etag go through the classifier's
 *     grammars. A change or a deletion reads the event first : it is declined
 *     when its etag moved, when it concerns somebody in a worse zone than the
 *     call stated, or when it is an invitation another person organizes.
 *     Writes are conditional (`If-None-Match: *`, `If-Match`), so nothing is
 *     overwritten that the agent did not read.
 */

import { createHash, randomUUID } from 'node:crypto';

import {
  CredentialRefusal,
  ExecutorRefusal,
  declining,
  undeclaredArgumentDenial,
  declaredArgumentsOf,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { parseBareAddress } from './address.ts';
import {
  calendarRef,
  etagValue,
  eventId,
  maxResultsOf,
  ownCalendars,
  readEventInput,
  readZoning,
  resolveCalendar,
  statedPeople,
  zoneExceeds,
  zoneOf,
  type CalendarZoning,
} from './classify.ts';
import { caldavAccount, caldavCredentialFields } from './credential.ts';
import {
  CALDAV_NS,
  DAV_NS,
  MAX_DISCOVERY_BYTES,
  MAX_OBJECT_BYTES,
  MAX_REPORT_BYTES,
  PROPFIND_CALENDARS,
  PROPFIND_HOME,
  PROPFIND_PRINCIPAL,
  calendarQuery,
  childElements,
  davSend,
  expectStatus,
  hrefsIn,
  parseMultistatus,
  propOf,
  resolveHref,
  textOf,
  type DavAccount,
  type DavEntry,
  type DavResponse,
} from './dav.ts';
import {
  GET_DESCRIPTION_CHARS,
  LIST_DESCRIPTION_CHARS,
  applyChange,
  buildEvent,
  concernedPeople,
  eventView,
  organizerOf,
} from './event.ts';
import { IcsError, parseIcs, serializeIcs, type IcsComponent } from './ical.ts';
import { CALDAV_PLUGIN_ID, CALDAV_TOOLS, TOOL } from './identity.ts';
import { icsUtc, readRange } from './times.ts';
import { caldavTools } from './tools.ts';

const DECLARED = declaredArgumentsOf(caldavTools);

/** Redirects discovery follows from one starting URL. */
const MAX_REDIRECTS = 5;
/** Calendars `list_calendars` reads, and discovery returns, at most. */
export const MAX_CALENDARS = 50;
const ICS_CONTENT_TYPE = 'text/calendar; charset=utf-8';

// ─── Results ───────────────────────────────────────────────────────────────

function ok(payload: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

const refuse = (message: string): never => {
  throw new ExecutorRefusal(`caldav: ${message}`);
};

// ─── Calendar refs ─────────────────────────────────────────────────────────

/** The last segment of a collection's path, decoded ; `null` when it does not decode. */
function lastSegment(url: URL): string | null {
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return null;
  }
}

/** The digest ref of a calendar whose last segment is not a ref (`cal-` and 16 hexadecimal digits). */
export const digestRef = (url: URL): string =>
  `cal-${createHash('sha256').update(url.pathname).digest('hex').slice(0, 16)}`;

/** The refs a calendar address may carry : its last segment when it is a ref, and its digest. */
function refsOf(url: URL): string[] {
  const segment = calendarRef(lastSegment(url));
  return segment === null ? [digestRef(url)] : [segment, digestRef(url)];
}

/** A collection URL with its trailing `/`, the base its event names resolve against. */
function asCollection(url: URL): URL {
  const out = new URL(url);
  if (!out.pathname.endsWith('/')) out.pathname = `${out.pathname}/`;
  return out;
}

/**
 * The address of a mission calendar : the resource's `href`, a URL the
 * account may reach, whose ref is the resource's. Anything else is declined :
 * the resource was not discovered by this plugin, or not for this account.
 */
function calendarUrl(resource: Resource, account: DavAccount): URL {
  const href = resource.metadata?.href;
  const url = typeof href === 'string' ? resolveHref(href, account.server, account.server) : null;
  if (url === null || !refsOf(url).includes(resource.ref)) {
    return refuse(
      `calendar '${resource.ref}' has no address on ${account.server.host}: refresh the resources of the connection.`,
    );
  }
  return asCollection(url);
}

/** The URL of an event of a calendar : its file name, one encoded segment under the collection. */
function eventUrl(calendar: URL, id: string): URL {
  const url = new URL(encodeURIComponent(id), calendar);
  if (url.pathname !== `${calendar.pathname}${encodeURIComponent(id)}`) {
    return refuse('event_id: does not name an event of the calendar.');
  }
  return url;
}

/** The event id of a multistatus href : a direct child of the calendar, in the id grammar ; `null` otherwise. */
function eventIdOfHref(href: string, calendar: URL, account: DavAccount): string | null {
  const url = resolveHref(href, calendar, account.server);
  if (url === null || url.pathname.endsWith('/')) return null;
  const parent = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
  if (parent !== calendar.pathname) return null;
  return eventId(lastSegment(url));
}

// ─── Zoning ────────────────────────────────────────────────────────────────

/** The account's address, organizer of what it schedules ; `null` when the server announced none. */
function accountAddress(zoning: CalendarZoning): string | null {
  return zoning.account_addresses.find((a) => parseBareAddress(a) !== null) ?? null;
}

// ─── Discovery ─────────────────────────────────────────────────────────────

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A network failure while connecting, as the sentence the person reads. */
async function connecting<T>(account: DavAccount, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof TypeError) {
      throw new CredentialRefusal(
        `could not reach ${account.server.host}: check the server URL and that the server is up.`,
      );
    }
    throw err;
  }
}

const signInRefused = (account: DavAccount): CredentialRefusal =>
  new CredentialRefusal(
    `${account.server.host} refused the sign-in of ${account.username.slice(0, 80)}: the username or the app password is wrong, or the app password was revoked.`,
  );

const outside = (account: DavAccount): CredentialRefusal =>
  new CredentialRefusal(
    `the server sends the account to a host outside ${account.server.host}: give the CalDAV address that server documents instead.`,
  );

type Ctx = Pick<ConnectionContext, 'fetch' | 'signal'>;

/** The principal found from one starting URL, redirects followed ; `null` when there is none there. */
async function principalFrom(ctx: Ctx, account: DavAccount, start: URL): Promise<URL | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await davSend(ctx, account, {
      method: 'PROPFIND',
      url,
      depth: '0',
      body: PROPFIND_PRINCIPAL,
      maxBytes: MAX_DISCOVERY_BYTES,
    });
    if (response.status === 401) throw signInRefused(account);
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location');
      if (location === null) return null;
      const next = resolveHref(location, url, account.server);
      if (next === null) throw outside(account);
      url = next;
      continue;
    }
    if (response.status !== 207) return null;
    let entries: DavEntry[];
    try {
      entries = parseMultistatus(response.text);
    } catch {
      return null;
    }
    const href = entries
      .map((e) => hrefsIn(propOf(e, DAV_NS, 'current-user-principal'))[0])
      .find((h) => h !== undefined && h.length > 0);
    if (href === undefined) return null;
    const principal = resolveHref(href, url, account.server);
    if (principal === null) throw outside(account);
    return principal;
  }
  return null;
}

/** The principal of the account : `/.well-known/caldav` first for a bare host (RFC 6764 §5), then the URL itself. */
async function findPrincipal(ctx: Ctx, account: DavAccount): Promise<URL> {
  const starts =
    account.server.pathname === '/'
      ? [new URL('/.well-known/caldav', account.server), account.server]
      : [account.server];
  for (const start of starts) {
    const principal = await principalFrom(ctx, account, start);
    if (principal !== null) return principal;
  }
  throw new CredentialRefusal(
    `no CalDAV account answers at ${account.server.toString().slice(0, 120)}: check the server URL (iCloud: https://caldav.icloud.com, Fastmail: https://caldav.fastmail.com, Nextcloud: https://<your cloud>/remote.php/dav).`,
  );
}

interface AccountInfo {
  readonly home: URL;
  /** The account's own e-mail addresses, lower-cased. */
  readonly addresses: readonly string[];
}

/** The calendar home and the addresses of a principal. */
async function principalInfo(ctx: Ctx, account: DavAccount, principal: URL): Promise<AccountInfo> {
  const response = await davSend(ctx, account, {
    method: 'PROPFIND',
    url: principal,
    depth: '0',
    body: PROPFIND_HOME,
    maxBytes: MAX_DISCOVERY_BYTES,
  });
  if (response.status === 401) throw signInRefused(account);
  expectStatus(response, [207], 'reading the principal');
  const entries = parseMultistatus(response.text);
  const homeHref = entries
    .map((e) => hrefsIn(propOf(e, CALDAV_NS, 'calendar-home-set'))[0])
    .find((h) => h !== undefined && h.length > 0);
  if (homeHref === undefined) {
    throw new CredentialRefusal(
      `${account.server.host} announces no calendar home for this account: it may offer no calendar over CalDAV.`,
    );
  }
  const home = resolveHref(homeHref, principal, account.server);
  if (home === null) throw outside(account);
  const addresses = new Set<string>();
  for (const e of entries) {
    for (const href of hrefsIn(propOf(e, CALDAV_NS, 'calendar-user-address-set'))) {
      const address = /^mailto:/i.test(href) ? parseBareAddress(href.slice(7)) : null;
      if (address !== null) addresses.add(address.address);
    }
  }
  const username = parseBareAddress(account.username);
  if (addresses.size === 0 && username !== null) addresses.add(username.address);
  return { home: asCollection(home), addresses: [...addresses] };
}

/** `entry` is a calendar collection that stores events. */
function isEventCalendar(entry: DavEntry): boolean {
  const type = propOf(entry, DAV_NS, 'resourcetype');
  if (!type || childElements(type, CALDAV_NS, 'calendar').length === 0) return false;
  const supported = propOf(entry, CALDAV_NS, 'supported-calendar-component-set');
  if (!supported) return true;
  return childElements(supported, CALDAV_NS, 'comp').some(
    (c) => (c.getAttribute('name') ?? '').toUpperCase() === 'VEVENT',
  );
}

const DESCRIPTION_CHARS = 300;

/** The calendars of the home, as resources. */
async function discoverCalendars(
  ctx: Ctx,
  account: DavAccount,
  info: AccountInfo,
): Promise<Resource[]> {
  const response = await davSend(ctx, account, {
    method: 'PROPFIND',
    url: info.home,
    depth: '1',
    body: PROPFIND_CALENDARS,
    maxBytes: MAX_DISCOVERY_BYTES,
  });
  expectStatus(response, [207], 'listing the calendars');
  const found: { url: URL; name: string; description: string }[] = [];
  for (const entry of parseMultistatus(response.text)) {
    if (!isEventCalendar(entry)) continue;
    const url = resolveHref(entry.href, info.home, account.server);
    if (url === null) continue;
    const collection = asCollection(url);
    if (collection.pathname === info.home.pathname) continue;
    found.push({
      url: collection,
      name: textOf(propOf(entry, DAV_NS, 'displayname')).slice(0, 200),
      description: textOf(propOf(entry, CALDAV_NS, 'calendar-description')).slice(
        0,
        DESCRIPTION_CHARS,
      ),
    });
  }
  // The last segment is the ref, unless it is not one or two calendars share it.
  const firstRef = (url: URL): string => refsOf(url)[0]!;
  const count = new Map<string, number>();
  for (const f of found) count.set(firstRef(f.url), (count.get(firstRef(f.url)) ?? 0) + 1);
  return found.slice(0, MAX_CALENDARS).map((f) => {
    const ref = count.get(firstRef(f.url)) === 1 ? firstRef(f.url) : digestRef(f.url);
    return {
      provider: CALDAV_PLUGIN_ID,
      ref,
      displayName: f.name.length > 0 ? f.name : ref,
      metadata: {
        href: f.url.toString(),
        description: f.description,
        account_addresses: info.addresses.join(' '),
        internal_domains: [],
        allowlist_domains: [],
        allowlist_addresses: [],
      },
    };
  });
}

// ─── Tools ─────────────────────────────────────────────────────────────────

/** The calendar object of an answer, or a thrown provider failure when it cannot be read. */
function readObject(response: DavResponse, what: string): IcsComponent {
  try {
    return parseIcs(response.text);
  } catch (err) {
    if (err instanceof IcsError) {
      throw new Error(
        `caldav: ${what} is not an iCalendar object the plugin can read (${err.message})`,
        { cause: err },
      );
    }
    throw err;
  }
}

async function listCalendars(ctx: ExecuteContext, account: DavAccount): Promise<McpToolResult> {
  const calendars: Record<string, unknown>[] = [];
  for (const resource of ownCalendars(ctx.resources).slice(0, MAX_CALENDARS)) {
    const url = calendarUrl(resource, account);
    const response = await davSend(ctx, account, {
      method: 'PROPFIND',
      url,
      depth: '0',
      body: PROPFIND_CALENDARS,
      maxBytes: MAX_DISCOVERY_BYTES,
    });
    expectStatus(response, [207], `reading calendar '${resource.ref}'`);
    const entry = parseMultistatus(response.text)[0];
    const name = entry ? textOf(propOf(entry, DAV_NS, 'displayname')) : '';
    const description = entry ? textOf(propOf(entry, CALDAV_NS, 'calendar-description')) : '';
    calendars.push({
      calendar: resource.ref,
      name: name.length > 0 ? name.slice(0, 200) : resource.displayName,
      description: description.length > 0 ? description.slice(0, DESCRIPTION_CHARS) : null,
    });
  }
  return ok({ calendars });
}

async function listEvents(
  ctx: ExecuteContext,
  account: DavAccount,
  resource: Resource,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const range = readRange(args.start, args.end);
  if ('denied' in range) return refuse(range.denied);
  const max = maxResultsOf(args.max_results) ?? refuse('max_results: out of range.');
  const url = calendarUrl(resource, account);
  const response = await davSend(ctx, account, {
    method: 'REPORT',
    url,
    depth: '1',
    body: calendarQuery(icsUtc(range.start), icsUtc(range.end)),
    maxBytes: MAX_REPORT_BYTES,
  });
  expectStatus(response, [207], 'searching the events');
  const events: Record<string, unknown>[] = [];
  for (const entry of parseMultistatus(response.text)) {
    const data = propOf(entry, CALDAV_NS, 'calendar-data');
    if (!data) continue;
    const id = eventIdOfHref(entry.href, url, account);
    const etag = textOf(propOf(entry, DAV_NS, 'getetag'));
    let view: ReturnType<typeof eventView>;
    try {
      view = eventView(parseIcs(textOf(data)), LIST_DESCRIPTION_CHARS);
    } catch {
      events.push({ event_id: id, etag: etag || null, unreadable: true });
      continue;
    }
    if (view !== null) events.push({ event_id: id, etag: etag || null, ...view });
  }
  events.sort((a, b) => String(a.start ?? '').localeCompare(String(b.start ?? '')));
  return ok({
    calendar: resource.ref,
    start: new Date(range.start).toISOString(),
    end: new Date(range.end).toISOString(),
    events: events.slice(0, max),
    total: events.length,
    truncated: events.length > max,
  });
}

/** The event id argument, by the classifier's grammar. */
const idArg = (args: Readonly<Record<string, unknown>>): string =>
  eventId(args.event_id) ?? refuse('event_id: missing or malformed.');

const etagArg = (args: Readonly<Record<string, unknown>>): string =>
  etagValue(args.etag) ?? refuse('etag: missing or malformed.');

/** GET of one event : its object and its etag. */
async function fetchEvent(
  ctx: ExecuteContext,
  account: DavAccount,
  url: URL,
): Promise<{ calendar: IcsComponent; etag: string | null }> {
  const response = await davSend(ctx, account, {
    method: 'GET',
    url,
    headers: { accept: 'text/calendar' },
    maxBytes: MAX_OBJECT_BYTES,
  });
  expectStatus(response, [200], 'reading the event');
  return { calendar: readObject(response, 'the event'), etag: response.headers.get('etag') };
}

async function getEvent(
  ctx: ExecuteContext,
  account: DavAccount,
  resource: Resource,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const id = idArg(args);
  const { calendar, etag } = await fetchEvent(
    ctx,
    account,
    eventUrl(calendarUrl(resource, account), id),
  );
  const view = eventView(calendar, GET_DESCRIPTION_CHARS);
  if (view === null) throw new Error('caldav: the object holds no event.');
  return ok({ calendar: resource.ref, event_id: id, etag, ...view });
}

interface RuntimeDeps {
  readonly now: () => Date;
  readonly uuid: () => string;
}

async function createEvent(
  ctx: ExecuteContext,
  account: DavAccount,
  resource: Resource,
  args: Readonly<Record<string, unknown>>,
  deps: RuntimeDeps,
): Promise<McpToolResult> {
  const input = readEventInput(args, 'create');
  if ('denied' in input) return refuse(input.denied);
  const zoning = readZoning(resource);
  const organizer = accountAddress(zoning);
  const invited = (input.attendees ?? []).filter(
    (p) => !zoning.account_addresses.includes(p.address),
  );
  if (invited.length > 0 && organizer === null) {
    return refuse(
      'the server announced no e-mail address for this account, so it cannot organize a meeting: create the event without attendees.',
    );
  }
  const uid = deps.uuid();
  const id = `${uid}.ics`;
  const url = eventUrl(calendarUrl(resource, account), id);
  const body = serializeIcs(buildEvent(input, { uid, now: deps.now(), organizer }));
  const response = await davSend(ctx, account, {
    method: 'PUT',
    url,
    body,
    contentType: ICS_CONTENT_TYPE,
    headers: { 'if-none-match': '*' },
    maxBytes: MAX_DISCOVERY_BYTES,
  });
  expectStatus(response, [200, 201, 204], 'creating the event');
  return ok({
    calendar: resource.ref,
    event_id: id,
    uid,
    etag: response.headers.get('etag'),
    created: true,
    invited: invited.map((p) => p.address),
  });
}

/**
 * The event read before a change or a deletion, held to the call : the etag
 * the agent read, and nobody concerned in a worse zone than it stated.
 */
async function readForWrite(
  ctx: ExecuteContext,
  account: DavAccount,
  resource: Resource,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ url: URL; calendar: IcsComponent; etag: string; zoning: CalendarZoning }> {
  const id = idArg(args);
  const etag = etagArg(args);
  const people = statedPeople(tool, args);
  if ('denied' in people) return refuse(people.denied);
  const url = eventUrl(calendarUrl(resource, account), id);
  const current = await fetchEvent(ctx, account, url);
  if (current.etag !== null && current.etag !== etag) {
    return refuse(
      `the event changed since it was read (etag ${current.etag.slice(0, 80)}, not ${etag.slice(0, 80)}): read it again with get_event.`,
    );
  }
  const zoning = readZoning(resource);
  const concerned = zoneOf(concernedPeople(current.calendar), zoning);
  const stated = zoneOf(people, zoning);
  if (zoneExceeds(concerned, stated)) {
    return refuse(
      `the event concerns people the call does not name (zone '${concerned}', the call states '${stated}'): ${tool === TOOL.deleteEvent ? 'give attendees, the organizer and attendees get_event lists' : 'give attendees, the full list after the change, and removed_attendees'}.`,
    );
  }
  return { url, calendar: current.calendar, etag, zoning };
}

async function updateEvent(
  ctx: ExecuteContext,
  account: DavAccount,
  resource: Resource,
  args: Readonly<Record<string, unknown>>,
  deps: RuntimeDeps,
): Promise<McpToolResult> {
  const input = readEventInput(args, 'update');
  if ('denied' in input) return refuse(input.denied);
  const { url, calendar, etag, zoning } = await readForWrite(
    ctx,
    account,
    resource,
    TOOL.updateEvent,
    args,
  );
  const organizer = accountAddress(zoning);
  const eventOrganizer = organizerOf(calendar);
  if (
    eventOrganizer !== undefined &&
    (eventOrganizer === null || !zoning.account_addresses.includes(eventOrganizer.address))
  ) {
    return refuse(
      `this event is an invitation organized by ${eventOrganizer?.address ?? 'somebody else'}: only its organizer changes it.`,
    );
  }
  const invited = (input.attendees ?? []).filter(
    (p) => !zoning.account_addresses.includes(p.address),
  );
  if (invited.length > 0 && organizer === null) {
    return refuse(
      'the server announced no e-mail address for this account, so it cannot organize a meeting: leave attendees out.',
    );
  }
  const declined = applyChange(calendar, input, { now: deps.now(), organizer });
  if (declined !== null) return refuse(declined);
  const response = await davSend(ctx, account, {
    method: 'PUT',
    url,
    body: serializeIcs(calendar),
    contentType: ICS_CONTENT_TYPE,
    headers: { 'if-match': etag },
    maxBytes: MAX_DISCOVERY_BYTES,
  });
  expectStatus(response, [200, 201, 204], 'changing the event');
  return ok({
    calendar: resource.ref,
    event_id: idArg(args),
    etag: response.headers.get('etag'),
    updated: true,
  });
}

async function deleteEvent(
  ctx: ExecuteContext,
  account: DavAccount,
  resource: Resource,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const { url, etag } = await readForWrite(ctx, account, resource, TOOL.deleteEvent, args);
  const response = await davSend(ctx, account, {
    method: 'DELETE',
    url,
    headers: { 'if-match': etag },
    maxBytes: MAX_DISCOVERY_BYTES,
  });
  expectStatus(response, [200, 204], 'deleting the event');
  return ok({ calendar: resource.ref, event_id: idArg(args), deleted: true });
}

// ─── Runtime ───────────────────────────────────────────────────────────────

export interface CaldavRuntimeOptions {
  /** The clock `DTSTAMP` is written with ; tests pin it. */
  readonly now?: () => Date;
  /** The UID of a new event (and its file name) ; tests pin it. */
  readonly uuid?: () => string;
}

export interface CaldavRuntime {
  execute(
    ctx: ExecuteContext,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpToolResult>;
  discoverResources(ctx: ConnectionContext): Promise<readonly Resource[]>;
  verify(ctx: ConnectionContext): Promise<CredentialCheck>;
  /** The credential spec, `verify` bound. */
  readonly credential: ApiKeyCredentialSpec;
}

export function createCaldavRuntime(options: CaldavRuntimeOptions = {}): CaldavRuntime {
  const deps: RuntimeDeps = {
    now: options.now ?? (() => new Date()),
    uuid: options.uuid ?? (() => randomUUID()),
  };

  const signIn = async (
    ctx: ConnectionContext,
  ): Promise<{ account: DavAccount; info: AccountInfo }> => {
    const account = caldavAccount(ctx.credential);
    return connecting(account, async () => {
      const principal = await findPrincipal(ctx, account);
      return { account, info: await principalInfo(ctx, account, principal) };
    });
  };

  const verify = async (ctx: ConnectionContext): Promise<CredentialCheck> => {
    const { account, info } = await signIn(ctx);
    return { account: info.addresses[0] ?? account.username, expiresAt: null };
  };

  return {
    credential: { ...caldavCredentialFields, verify },
    verify,

    async discoverResources(ctx) {
      const { account, info } = await signIn(ctx);
      return connecting(account, () => discoverCalendars(ctx, account, info));
    },

    execute(ctx, tool, args) {
      return declining(async () => {
        if (!CALDAV_TOOLS.includes(tool)) return refuse(`unknown tool '${tool}'.`);
        const undeclared = undeclaredArgumentDenial(DECLARED, tool, args);
        if (undeclared !== null) return refuse(undeclared);
        const account = caldavAccount(ctx.credential);
        if (tool === TOOL.listCalendars) return listCalendars(ctx, account);
        const resource = resolveCalendar(args, ctx.resources);
        if ('denied' in resource) return refuse(resource.denied);
        switch (tool) {
          case TOOL.listEvents:
            return listEvents(ctx, account, resource, args);
          case TOOL.getEvent:
            return getEvent(ctx, account, resource, args);
          case TOOL.createEvent:
            return createEvent(ctx, account, resource, args, deps);
          case TOOL.updateEvent:
            return updateEvent(ctx, account, resource, args, deps);
          default:
            return deleteEvent(ctx, account, resource, args);
        }
      });
    },
  };
}
