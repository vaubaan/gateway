/**
 * The times a tool takes and the times an event carries.
 *
 * Handbook : docs/handbook/providers/caldav.md.
 *
 * Pure : no clock. Three spellings an agent may write, each read strictly
 * (a value that does not match is refused, never guessed) :
 *
 *   - an instant, `2026-10-27T09:30:00Z` or `2026-10-27T10:30:00+01:00`
 *     (seconds optional) — written to the event in UTC ;
 *   - a wall-clock time with a `timezone` (`Europe/Paris`) —
 *     `2026-10-27T10:30:00`, written with `TZID=Europe/Paris` ;
 *   - a date, `2026-10-27`, for an all-day event, whose end is exclusive
 *     (the day after the last day), as in RFC 5545 and Google Calendar.
 *
 * The range of `list_events` takes instants or dates (a date is midnight UTC).
 */

import type { IcsParam, IcsProperty } from './ical.ts';
import { paramOf } from './ical.ts';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/;

/** Longest range `list_events` reads, in days ; a longer one is refused. */
export const MAX_RANGE_DAYS = 366;
/** Longest range read with `caldav.read-events` alone ; beyond, `caldav.read-wide-range` too. */
export const NARROW_RANGE_DAYS = 31;
const DAY_MS = 86_400_000;

interface Fields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** The fields of a match, or `null` when they name no real date or time (`2026-02-30`, `25:00`). */
function fieldsOf(m: RegExpExecArray, withTime: boolean): Fields | null {
  const f: Fields = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: withTime ? Number(m[4]) : 0,
    minute: withTime ? Number(m[5]) : 0,
    second: withTime && m[6] !== undefined ? Number(m[6]) : 0,
  };
  if (f.hour > 23 || f.minute > 59 || f.second > 59) return null;
  const date = new Date(Date.UTC(f.year, f.month - 1, f.day));
  return date.getUTCFullYear() === f.year &&
    date.getUTCMonth() === f.month - 1 &&
    date.getUTCDate() === f.day
    ? f
    : null;
}

const utcMs = (f: Fields): number =>
  Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);

/** Minutes east of UTC of `+01:00` / `-05:30` / `Z`, or `null` beyond ±14:00. */
function offsetMinutes(offset: string): number | null {
  if (offset === 'Z') return 0;
  const sign = offset.startsWith('-') ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (hours > 14 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

/** An instant (`…Z` or `…±hh:mm`) → milliseconds since the epoch, or `null`. */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = INSTANT.exec(value);
  if (!m) return null;
  const f = fieldsOf(m, true);
  const offset = offsetMinutes(m[7]!);
  return f === null || offset === null ? null : utcMs(f) - offset * 60_000;
}

/** A date (`2026-10-27`) → its midnight UTC in milliseconds, or `null`. */
export function parseDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = DATE.exec(value);
  const f = m ? fieldsOf(m, false) : null;
  return f === null ? null : utcMs(f);
}

/** A bound of `list_events` : an instant, or a date as midnight UTC. */
export function parseRangeBound(value: unknown): number | null {
  return parseInstant(value) ?? parseDate(value);
}

export type RangeOutcome =
  | { readonly start: number; readonly end: number; readonly wide: boolean }
  | { readonly denied: string };

/** The range of `list_events`, checked : both bounds, end after start, at most `MAX_RANGE_DAYS`. */
export function readRange(start: unknown, end: unknown): RangeOutcome {
  const from = parseRangeBound(start);
  if (from === null) return { denied: `start: ${BOUND_HINT}` };
  const to = parseRangeBound(end);
  if (to === null) return { denied: `end: ${BOUND_HINT}` };
  if (to <= from) return { denied: 'end: must be after start.' };
  if (to - from > MAX_RANGE_DAYS * DAY_MS) {
    return { denied: `the range is longer than ${MAX_RANGE_DAYS} days: split it.` };
  }
  return { start: from, end: to, wide: to - from > NARROW_RANGE_DAYS * DAY_MS };
}

const BOUND_HINT =
  "missing or malformed: a date ('2026-10-27') or an instant with its offset ('2026-10-27T09:00:00Z', '2026-10-27T10:00:00+01:00').";

/** `20261027T090000Z`, the UTC form of CalDAV's `time-range` and of `DTSTAMP`. */
export function icsUtc(ms: number): string {
  const d = new Date(ms);
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// ─── Event times written by a tool ─────────────────────────────────────────

/** An IANA time zone name the runtime knows (`Europe/Paris`, `UTC`), or `null`. */
export function timeZoneName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  // Letters, digits, `_`, `+`, `-`, segments joined by `/` : checked segment by segment.
  if (!value.split('/').every((segment) => /^[A-Za-z][A-Za-z0-9_+-]*$/.test(segment))) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** One bound of an event as the tool writes it : the property's parameters and value, and a key that orders it. */
export interface EventTime {
  readonly params: readonly IcsParam[];
  readonly value: string;
  /** Comparable within one kind (dates, instants, or wall-clock times of one zone). */
  readonly order: number;
}

export type EventTimeKind = 'date' | 'zoned' | 'instant';

/**
 * A bound of `create_event` / `update_event`, or the reason it is refused.
 * `allDay` asks for a date ; a `timezone` for a wall-clock time ; neither for
 * an instant with its offset.
 */
export function eventTime(
  value: unknown,
  kind: EventTimeKind,
  timezone: string | null,
): EventTime | string {
  if (typeof value !== 'string') return 'missing.';
  if (kind === 'date') {
    const ms = parseDate(value);
    if (ms === null) return "an all-day event takes a date, '2026-10-27'.";
    return {
      params: [{ name: 'VALUE', values: ['DATE'] }],
      value: value.replace(/-/g, ''),
      order: ms,
    };
  }
  if (kind === 'zoned') {
    const m = LOCAL.exec(value);
    const f = m ? fieldsOf(m, true) : null;
    if (f === null) {
      return "with a timezone, a wall-clock time without offset, '2026-10-27T10:30:00'.";
    }
    return {
      params: [{ name: 'TZID', values: [timezone!] }],
      value: `${pad(f.year, 4)}${pad(f.month)}${pad(f.day)}T${pad(f.hour)}${pad(f.minute)}${pad(f.second)}`,
      order: utcMs(f),
    };
  }
  const ms = parseInstant(value);
  if (ms === null) {
    return "an instant with its offset, '2026-10-27T09:30:00Z' or '2026-10-27T10:30:00+01:00' (or give a timezone).";
  }
  return { params: [], value: icsUtc(ms), order: ms };
}

// ─── Event times read from a server ────────────────────────────────────────

/** How an event's `DTSTART` / `DTEND` reads back to the agent. */
export interface TimeView {
  /** `2026-10-27`, `2026-10-27T09:30:00Z`, or a wall-clock `2026-10-27T10:30:00`. */
  readonly time: string;
  /** The `TZID`, `UTC` for an instant, `null` for a date or a floating time. */
  readonly timezone: string | null;
  readonly allDay: boolean;
}

const ICS_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const ICS_DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

/** A `DTSTART` / `DTEND` / `RECURRENCE-ID` as the agent reads it, or `null` when it is not one the plugin reads. */
export function timeView(property: IcsProperty | undefined): TimeView | null {
  if (property === undefined) return null;
  const value = property.value.trim();
  const date = ICS_DATE.exec(value);
  if (date) return { time: `${date[1]}-${date[2]}-${date[3]}`, timezone: null, allDay: true };
  const m = ICS_DATE_TIME.exec(value);
  if (!m) return null;
  const time = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  if (m[7] === 'Z') return { time: `${time}Z`, timezone: 'UTC', allDay: false };
  const tzid = paramOf(property, 'TZID');
  return { time, timezone: tzid !== undefined && tzid.length <= 64 ? tzid : null, allDay: false };
}
