/**
 * The identifier grammars of the `outlook` provider, shared by `classify`,
 * `execute` and discovery. Each returns the value or `null`; a value outside
 * its grammar is refused, never repaired.
 *
 * Handbook : docs/handbook/providers/outlook.md ("Identifiers").
 * ADR      : docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md.
 */

import { WELL_KNOWN_FOLDERS } from './identity.ts';

/**
 * A Microsoft Graph id (message, attachment, folder, calendar, event): the
 * URL-safe base64 Graph writes (`AAMkAGI2TGuLAAA=`, `-` and `_` in place of
 * `+` and `/`), up to 512 characters. `+` is kept for ids written in the
 * other alphabet; `/` is not accepted: in a path segment it would be
 * percent-encoded and Graph may decode it. No `.`, no `%`, no `?` or `#`:
 * never a dot segment or a delimiter. In a slice it goes through
 * `identSegment` (a `+` or `=` makes it `[*]`).
 */
export const GRAPH_ID = /^[A-Za-z0-9+=_-]{1,512}$/;

export function graphId(value: unknown): string | null {
  return typeof value === 'string' && GRAPH_ID.test(value) ? value : null;
}

const WELL_KNOWN: ReadonlySet<string> = new Set(WELL_KNOWN_FOLDERS);

/** A folder: one of Graph's well-known names (any case, read lower-cased), or a folder id. */
export function folderRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  if (WELL_KNOWN.has(lower)) return lower;
  return graphId(value);
}

/** Whether a folder value is a well-known name (`folderRef` returned it lower-cased). */
export function isWellKnownFolder(folder: string): boolean {
  return WELL_KNOWN.has(folder);
}

/**
 * One path segment of a request URL from a value its grammar already
 * accepted: refused (`null`) when it is empty, a dot segment, or holds `/`,
 * `?`, `#`, `%`, `\` or a control character — never repaired — then
 * percent-encoded (`AAMk+A=` → `AAMk%2BA%3D`).
 */
export function pathSegment(value: string): string | null {
  if (value === '' || value === '.' || value === '..') return null;
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/[/?#%\\\u0000-\u001f\u007f]/.test(value)) return null;
  return encodeURIComponent(value);
}

/** The ref of a mailbox from the account's address: lower-cased, `@` written `~` (alice~contoso.com). */
export function mailboxRefOf(address: string): string {
  return address.toLowerCase().replace('@', '~');
}

/** An instant of RFC 3339 with an offset (2026-11-05T09:00:00Z), as milliseconds, or `null`. */
export function instantOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** A local date-time without offset (2026-11-05T09:30 or 2026-11-05T09:30:00), as Graph's dateTime. */
export function localDateTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return null;
  const [, day, hh, mm, ss] = m;
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? '0') > 59) return null;
  if (Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return null;
  return `${day}T${hh}:${mm}:${ss ?? '00'}`;
}

/**
 * A time zone name Graph's dateTimeTimeZone takes: a Windows name
 * (`W. Europe Standard Time`) or an IANA one (`Europe/Paris`). Letters,
 * digits, space and `_ + - / . ( ) ,`, 1 to 64 characters. It travels in a
 * JSON body only, never in a URL.
 */
export function timeZoneName(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _+\-/.(),]{0,63}$/.test(value)
    ? value
    : null;
}

// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const CONTROL_ALL = /[\u0000-\u001f\u007f]/;

/** Text an agent writes (a subject, a folder name, a comment): no control character but tab and line breaks, bounded. */
export function freeText(value: unknown, max: number, lines: boolean): string | null {
  if (typeof value !== 'string' || value.length > max) return null;
  return (lines ? CONTROL_BUT_LINES : CONTROL_ALL).test(value) ? null : value;
}
