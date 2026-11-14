/**
 * WebDAV / CalDAV over `ctx.fetch` : the requests the plugin sends, the
 * multistatus answers it reads, and where the app password may be sent.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §2.4 (the executor), §5.
 * Handbook : docs/handbook/providers/caldav.md.
 *
 *   - **Where** : the server URL the person typed is the anchor. A request
 *     goes to the same scheme, port and host, or to the one host of the
 *     calendar home, pinned (security audit 2026-10-31, L3). The home's host
 *     is accepted once, when the principal announces it at discovery, and
 *     only as a sibling of the server under the same parent domain (iCloud
 *     answers `caldav.icloud.com` with a calendar home on
 *     `p43-caldav.icloud.com`); the calendars stored at discovery carry it,
 *     and a call goes to its calendar's host and the server's, nowhere else.
 *     `https` only, `http` for a loopback host alone. Anything else is
 *     refused before a request is built, so the `Authorization` header never
 *     leaves for a host the person did not name — whatever a server's answer
 *     says.
 *   - **What** : the XML bodies are fixed texts ; the one value inserted, the
 *     `time-range` of a `REPORT`, is formatted by the plugin from a parsed
 *     instant. Answers are read with `@xmldom/xmldom`, bounded in size, a
 *     document type refused (no entity of any kind is expanded), namespaces
 *     resolved, so `D:`, `d:` or no prefix at all read the same.
 *   - **How it fails** : 401 and 403 are `UpstreamAuthError`, any other
 *     unexpected status an `UpstreamHttpError` ; nothing is retried.
 */

import { DOMParser, onErrorStopParsing, type Element, type Node } from '@xmldom/xmldom';

import { UpstreamAuthError, UpstreamHttpError, type AccountContext } from '@vaubaan/plugin-sdk';

export const DAV_NS = 'DAV:';
export const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';

/** The sign-in of a CalDAV account, narrowed from the decrypted secret (`credential.ts`). */
export interface DavAccount {
  /** The server URL the person typed, normalised (`https://caldav.icloud.com/`). */
  readonly server: URL;
  readonly username: string;
  readonly password: string;
  /**
   * The calendar home (or the calendar) the requests of this discovery or call are
   * pinned to, when it is not on the server's host: the one other host the password
   * may go to. Absent: the server's host only.
   */
  readonly home?: URL;
}

/** The account pinned to the host of `home` (`DavAccount.home`). */
export function pinnedTo(account: DavAccount, home: URL): DavAccount {
  return { ...account, home };
}

// ─── Where the credential may go ───────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `http:` is accepted for a loopback host only (a server on the same machine, a test). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

const isIpLiteral = (host: string): boolean =>
  host.startsWith('[') || host.split('.').every((part) => /^\d{1,3}$/.test(part));

/** Same scheme and port as the server URL, no user name or password in it. */
function isOnServerScheme(target: URL, server: URL): boolean {
  return (
    target.protocol === server.protocol &&
    target.port === server.port &&
    target.username === '' &&
    target.password === ''
  );
}

/**
 * `target` may hold a calendar home of the server : the same host, or a sibling
 * of it under the same parent domain (`p43-caldav.icloud.com` for
 * `caldav.icloud.com`). A parent of two labels or fewer (`example.com` for
 * `example.com`), an IP literal or a loopback host admits the host itself only.
 * Asked once per discovery, of the home the principal announces, and of a
 * stored calendar at a call ; the requests then stay on that host.
 */
export function isHomeHost(target: URL, server: URL): boolean {
  if (!isOnServerScheme(target, server)) return false;
  const host = target.hostname.toLowerCase();
  const anchor = server.hostname.toLowerCase();
  if (host === anchor) return true;
  if (isIpLiteral(anchor) || isLoopbackHost(anchor)) return false;
  const labels = anchor.split('.');
  if (labels.length < 3) return false;
  const parent = labels.slice(1).join('.');
  return host.endsWith(`.${parent}`);
}

/**
 * `target` is a place the account's password may be sent : same scheme and port
 * as the server URL, and the server's host or the pinned home's (`DavAccount.home`).
 */
export function isAllowedTarget(
  target: URL,
  account: Pick<DavAccount, 'server' | 'home'>,
): boolean {
  if (!isOnServerScheme(target, account.server)) return false;
  const host = target.hostname.toLowerCase();
  return (
    host === account.server.hostname.toLowerCase() ||
    (account.home !== undefined && host === account.home.hostname.toLowerCase())
  );
}

/** `href` (absolute or relative to `base`) as a URL, when `allowed`; `null` otherwise. */
function resolveIf(href: string, base: URL, allowed: (url: URL) => boolean): URL | null {
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return null;
  }
  url.hash = '';
  return allowed(url) && url.search === '' ? url : null;
}

/** `href` (absolute or relative to `base`) as a URL the account may reach, or `null`. */
export function resolveHref(
  href: string,
  base: URL,
  account: Pick<DavAccount, 'server' | 'home'>,
): URL | null {
  return resolveIf(href, base, (url) => isAllowedTarget(url, account));
}

/** `href` as a calendar home of the server (`isHomeHost`), or `null`. */
export function resolveHomeHref(href: string, base: URL, server: URL): URL | null {
  return resolveIf(href, base, (url) => isHomeHost(url, server));
}

// ─── Requests ──────────────────────────────────────────────────────────────

/** Largest answer read, in bytes, by kind of request. */
export const MAX_DISCOVERY_BYTES = 1_000_000;
export const MAX_REPORT_BYTES = 10_000_000;
export const MAX_OBJECT_BYTES = 1_000_000;

export interface DavRequest {
  readonly method: 'PROPFIND' | 'REPORT' | 'GET' | 'PUT' | 'DELETE';
  readonly url: URL;
  readonly depth?: '0' | '1';
  readonly body?: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxBytes: number;
}

export interface DavResponse {
  readonly status: number;
  readonly url: URL;
  readonly headers: Headers;
  readonly text: string;
}

/** An answer larger than its bound : a provider failure, thrown. */
export class DavTooLarge extends Error {
  constructor(maxBytes: number) {
    super(`caldav: the server answered more than ${maxBytes} bytes.`);
    this.name = 'DavTooLarge';
  }
}

/** The `Authorization` value of the account (RFC 7617). */
export function basicAuthorization(account: DavAccount): string {
  return `Basic ${Buffer.from(`${account.username}:${account.password}`, 'utf8').toString('base64')}`;
}

/**
 * One request, signed with the account, never redirected (a `3xx` is
 * returned as it is ; discovery follows it itself, through the same check).
 * Throws when the URL is not one the account may reach.
 */
export async function davSend(
  ctx: Pick<AccountContext, 'fetch' | 'signal'>,
  account: DavAccount,
  request: DavRequest,
): Promise<DavResponse> {
  if (!isAllowedTarget(request.url, account)) {
    throw new Error(`caldav: refusing to send the credential to ${request.url.host}.`);
  }
  const headers: Record<string, string> = {
    authorization: basicAuthorization(account),
    ...(request.depth !== undefined ? { depth: request.depth } : {}),
    ...(request.body !== undefined
      ? { 'content-type': request.contentType ?? 'application/xml; charset=utf-8' }
      : {}),
    ...request.headers,
  };
  const response = await ctx.fetch(request.url.toString(), {
    method: request.method,
    headers,
    redirect: 'manual',
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const text = await readBounded(response, request.maxBytes);
  return { status: response.status, url: request.url, headers: response.headers, text };
}

/** The body of a response as text, at most `maxBytes` ; `DavTooLarge` beyond. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new DavTooLarge(maxBytes);
  }
  if (!response.body) return '';
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new DavTooLarge(maxBytes);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The status is one of `expected`, or the failure : `UpstreamAuthError` for
 * 401 / 403, `UpstreamHttpError` otherwise. `what` names the request in the
 * plugin's words ; the server's text is not repeated.
 */
export function expectStatus(
  response: DavResponse,
  expected: readonly number[],
  what: string,
): void {
  if (expected.includes(response.status)) return;
  if (response.status === 401) {
    throw new UpstreamAuthError(
      `caldav: ${response.url.host} refused the sign-in (${what}): the app password is wrong or was revoked.`,
      401,
    );
  }
  if (response.status === 403) {
    throw new UpstreamAuthError(
      `caldav: ${response.url.host} refused ${what} (HTTP 403): the account may not do this on this calendar (a read-only or shared calendar).`,
      403,
    );
  }
  throw new UpstreamHttpError(
    `caldav: ${response.url.host} answered HTTP ${response.status} to ${what}${STATUS_HINTS[response.status] ?? '.'}`,
    response.status,
  );
}

const STATUS_HINTS: Readonly<Record<number, string>> = {
  404: ': not found.',
  409: ': the calendar does not accept it.',
  412: ': the event changed since it was read (its etag no longer matches); read it again.',
  415: ': the server does not accept this iCalendar object.',
  507: ': the server is out of space.',
};

// ─── Request bodies ────────────────────────────────────────────────────────

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';

export const PROPFIND_PRINCIPAL = `${XML_HEAD}<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

export const PROPFIND_HOME = `${XML_HEAD}<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/><c:calendar-user-address-set/><d:displayname/></d:prop></d:propfind>`;

export const PROPFIND_CALENDARS = `${XML_HEAD}<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:calendar-description/><c:supported-calendar-component-set/></d:prop></d:propfind>`;

/** `start` / `end` : the UTC form `20261027T000000Z`, formatted by the plugin (`icsUtc`). */
export function calendarQuery(start: string, end: string): string {
  if (!/^\d{8}T\d{6}Z$/.test(start) || !/^\d{8}T\d{6}Z$/.test(end)) {
    throw new Error('caldav: a time-range bound is not a UTC date-time.');
  }
  return (
    `${XML_HEAD}<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
    '<d:prop><d:getetag/><c:calendar-data/></d:prop>' +
    '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">' +
    `<c:time-range start="${start}" end="${end}"/>` +
    '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>'
  );
}

// ─── Multistatus ───────────────────────────────────────────────────────────

/** One `response` of a multistatus : its href, and the properties its `200` propstats carry. */
export interface DavEntry {
  readonly href: string;
  /** Properties found (status 200), keyed `namespace|local-name`. */
  readonly props: ReadonlyMap<string, Element>;
}

/** The answer is not a multistatus the plugin can read : a provider failure, thrown. */
export class DavParseError extends Error {
  constructor(message: string) {
    super(`caldav: ${message}`);
    this.name = 'DavParseError';
  }
}

const key = (ns: string, local: string): string => `${ns}|${local}`;

const isElement = (node: Node): node is Element => node.nodeType === 1;

/** The element children of `parent`, optionally of one name. */
export function childElements(parent: Element, ns?: string, local?: string): Element[] {
  const out: Element[] = [];
  for (let n = parent.firstChild; n !== null; n = n.nextSibling) {
    if (!isElement(n)) continue;
    if (ns !== undefined && (n.namespaceURI !== ns || n.localName !== local)) continue;
    out.push(n);
  }
  return out;
}

/** The text of an element, trimmed. */
export const textOf = (element: Element | undefined): string => (element?.textContent ?? '').trim();

/** The `DAV:href` texts directly under `element`. */
export const hrefsIn = (element: Element | undefined): string[] =>
  element ? childElements(element, DAV_NS, 'href').map((h) => textOf(h)) : [];

/** A property of an entry, by namespace and local name. */
export const propOf = (entry: DavEntry, ns: string, local: string): Element | undefined =>
  entry.props.get(key(ns, local));

/** The `DAV:status` line → its code, or `null`. */
function statusCode(element: Element | undefined): number | null {
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(textOf(element));
  return m ? Number(m[1]) : null;
}

/**
 * The entries of a `207 Multi-Status` body (RFC 4918 §13). A document type, a
 * syntax error or another root refuses the answer ; a `response` without a
 * `200` propstat has no property.
 */
export function parseMultistatus(text: string): DavEntry[] {
  if (/<!DOCTYPE/i.test(text)) throw new DavParseError('the answer declares a document type.');
  let root: Element | null;
  try {
    root = new DOMParser({ onError: onErrorStopParsing }).parseFromString(
      text,
      'application/xml',
    ).documentElement;
  } catch {
    throw new DavParseError('the answer is not well-formed XML.');
  }
  if (!root || root.namespaceURI !== DAV_NS || root.localName !== 'multistatus') {
    throw new DavParseError('the answer is not a WebDAV multistatus.');
  }
  return childElements(root, DAV_NS, 'response').map((response) => {
    const props = new Map<string, Element>();
    for (const propstat of childElements(response, DAV_NS, 'propstat')) {
      if (statusCode(childElements(propstat, DAV_NS, 'status')[0]) !== 200) continue;
      for (const prop of childElements(propstat, DAV_NS, 'prop')) {
        for (const p of childElements(prop)) {
          props.set(key(p.namespaceURI ?? '', p.localName ?? ''), p);
        }
      }
    }
    return { href: hrefsIn(response)[0] ?? '', props };
  });
}
