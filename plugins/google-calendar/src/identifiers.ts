/**
 * The identifier grammars of the `google-calendar` service, shared by
 * `classify`, `execute` and discovery. Each returns the value or `null`; a
 * value outside its grammar is refused, never repaired.
 *
 * Handbook : docs/handbook/services/google-calendar.md.
 * ADR      : docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md.
 */

/**
 * A Google calendar id: an address-shaped id (`alice@acme.com`,
 * `c_8f2…@group.calendar.google.com`). Calendars whose id carries a `#`
 * (Google's subscribed calendars: holidays, birthdays, contacts) or a `+`, a
 * `%`, a `~` are outside the grammar: they are not discovered and never
 * reached.
 */
export const CALENDAR_ID = /^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9.-]{1,253}$/;

/**
 * A calendar ref: the calendar id with its `@` written `~` (`alice~acme.com`),
 * which a slice identifier carries as it is. One to one with the id.
 */
export const CALENDAR_REF = /^[A-Za-z0-9._-]{1,128}~[A-Za-z0-9.-]{1,253}$/;

/**
 * An event id: Google writes base32hex ids, an instance of a recurring event
 * adds `_<date>`; imported events keep their own letters. Letters, digits, `_`
 * and `-`: a slice identifier and one URL path segment at once.
 */
export const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;

/** The ref of a calendar id, or `null` outside the grammar. */
export function calendarRefOf(id: unknown): string | null {
  if (typeof id !== 'string' || !CALENDAR_ID.test(id)) return null;
  return id.replace('@', '~');
}

/** The calendar id of a ref, or `null` outside the grammar. */
export function calendarIdOf(ref: unknown): string | null {
  if (typeof ref !== 'string' || !CALENDAR_REF.test(ref)) return null;
  return ref.replace('~', '@');
}

/** The ref a `calendarId` argument names: a ref or a calendar id; `null` for anything else. */
export function calendarRefFromArgument(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (CALENDAR_REF.test(text)) return text;
  return calendarRefOf(text);
}

export function eventId(value: unknown): string | null {
  return typeof value === 'string' && EVENT_ID.test(value) ? value : null;
}

/**
 * One path segment of a request URL from a value its grammar already
 * accepted: refused (`null`) when it is empty, a dot segment, or holds `/`,
 * `?`, `#`, `%`, `\` or a control character — never repaired — then
 * percent-encoded (`alice@acme.com` → `alice%40acme.com`).
 */
export function pathSegment(value: string): string | null {
  if (value === '' || value === '.' || value === '..') return null;
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/[/?#%\\\u0000-\u001f\u007f]/.test(value)) return null;
  return encodeURIComponent(value);
}

/** One e-mail address, lower-cased, parsed strictly: a dot-atom local part and a domain. */
export interface EmailAddress {
  readonly address: string;
  readonly domain: string;
}

/** One dot-separated atom of a local part. */
const LOCAL_ATOM = /^[a-z0-9!#$&'*+/=?^_`{|}-]{1,64}$/;
/** One DNS label: letters, digits and inner hyphens. */
const DOMAIN_LABEL = /^[a-z0-9-]{1,63}$/;

function isLocalPart(local: string): boolean {
  return local.length <= 64 && local.split('.').every((atom) => LOCAL_ATOM.test(atom));
}

function isDomain(domain: string): boolean {
  const labels = domain.split('.');
  return (
    labels.length >= 2 &&
    domain.length <= 253 &&
    labels.every((l) => DOMAIN_LABEL.test(l) && !l.startsWith('-') && !l.endsWith('-'))
  );
}

/**
 * A value that is exactly one address, or `null`: no display name, no list,
 * no comment, no quoted local part. A value the mail system could read as two
 * addresses never parses as one. (The same rules as `plugins/gmail/src/address.ts`;
 * plugins do not import each other.)
 */
export function parseAddress(value: unknown): EmailAddress | null {
  if (typeof value !== 'string' || value.length > 320) return null;
  const address = value.trim().toLowerCase();
  const at = address.indexOf('@');
  if (at <= 0 || at !== address.lastIndexOf('@')) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!isLocalPart(local) || !isDomain(domain)) return null;
  return { address, domain };
}
