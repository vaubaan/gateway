/**
 * Identifier and value grammars of the `asana` provider, shared by `classify`
 * and `execute` (ADR plugin-identifiers-one-grammar-for-classify-and-execute).
 *
 * Handbook : docs/handbook/providers/asana.md, "Identifiers".
 *
 * A value outside its grammar is refused, never trimmed, escaped or read as
 * absent. Every grammar is closed and bounded.
 */

/**
 * An Asana gid : decimal digits ("globally unique identifier", a string of
 * digits in every answer the documentation shows). One URL path segment,
 * and a valid slice identifier.
 */
const GID = /^[0-9]{1,32}$/;

export function asanaGid(value: unknown): string | null {
  return typeof value === 'string' && GID.test(value) ? value : null;
}

/**
 * A pagination offset : opaque for Asana, which documents a JWT
 * (`eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9` decodes to `{"typ":"JWT",…}`), so
 * base64url segments joined by dots. It only ever travels in a query string
 * built with `URLSearchParams`. A value made of dots alone is refused all the
 * same : it is no offset.
 */
const OFFSET = /^[A-Za-z0-9_=.-]{1,1024}$/;

export function offsetToken(value: unknown): string | null {
  return typeof value === 'string' && OFFSET.test(value) && !/^\.+$/.test(value) ? value : null;
}

/** A calendar date, `YYYY-MM-DD` (`due_on`). */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isoDate(value: unknown): string | null {
  return typeof value === 'string' && DATE.test(value) ? value : null;
}

/** An ISO-8601 timestamp with its zone (`2026-11-05T09:30:00.000Z`). */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** `completed_since` : `now` (only incomplete tasks) or a timestamp. */
export function completedSince(value: unknown): string | null {
  if (value === 'now') return value;
  return typeof value === 'string' && TIMESTAMP.test(value) ? value : null;
}

/** An assignee : the literal `me` (Asana accepts it) or a user gid ; never an address. */
export function assigneeIdent(value: unknown): string | null {
  return value === 'me' ? value : asanaGid(value);
}

/** An integer within `[min, max]`, or `null`. */
export function boundedInt(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

// eslint-disable-next-line no-control-regex -- the grammar is about control characters
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- the grammar is about control characters
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Longest search text sent to Asana. */
export const MAX_SEARCH_TEXT = 500;
/** Longest task name accepted. */
export const MAX_NAME = 1024;
/** Longest task description or comment accepted. */
export const MAX_LONG_TEXT = 65_535;

/** One line of text, `1..max` characters, no control character. */
export function lineText(value: unknown, max: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !CONTROL.test(value)
    ? value
    : null;
}

/** Text that may hold line breaks and tabs, `1..max` characters, no other control character. */
export function longText(value: unknown, max: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !CONTROL_BUT_LINES.test(value)
    ? value
    : null;
}
