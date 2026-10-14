/**
 * How the interface writes an instant — the one place a date becomes text.
 *
 * One form everywhere, and it does not depend on the reader's locale: the day
 * as "14 Oct" (with the year when it is not this one), the clock on 24 hours
 * as "01:48" (with seconds where a record is read down a column), and the two
 * together as "14 Oct, 01:48". No `toLocaleString`: a browser set to US
 * English would print "10/14/2026, 1:48:59 AM" beside a page that says
 * "14 Oct".
 *
 * The locale never changes the text; the time zone does. The server does not
 * know the reader's zone, so it writes the instant in UTC (`zone: 'utc'`, the
 * default) and the browser replaces it with the reader's own after hydration
 * (`zone: 'local'`: `LocalDate`, `When`, `Today`). A text that must be the
 * same on both sides — a sentence built on the server — stays in UTC.
 *
 * Pure and browser-safe: no import.
 */

export type DateZone = 'utc' | 'local';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Parts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}

function partsOf(date: Date, zone: DateZone): Parts {
  return zone === 'utc'
    ? {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth(),
        day: date.getUTCDate(),
        weekday: date.getUTCDay(),
        hours: date.getUTCHours(),
        minutes: date.getUTCMinutes(),
        seconds: date.getUTCSeconds(),
      }
    : {
        year: date.getFullYear(),
        month: date.getMonth(),
        day: date.getDate(),
        weekday: date.getDay(),
        hours: date.getHours(),
        minutes: date.getMinutes(),
        seconds: date.getSeconds(),
      };
}

const two = (n: number): string => String(n).padStart(2, '0');

export interface DateOptions {
  /** `utc` (the default) on the server; `local` in the browser, after hydration. */
  readonly zone?: DateZone;
  /** "This year" is read from it; a page passes the instant it was rendered at. */
  readonly now?: Date;
}

/** "14 Oct"; "14 Oct 2025" when it is not this year; `''` for an instant that is not one. */
export function formatDay(at: Date | string, options: DateOptions = {}): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const zone = options.zone ?? 'utc';
  const parts = partsOf(date, zone);
  const day = `${parts.day} ${MONTHS[parts.month] ?? ''}`;
  return parts.year === partsOf(options.now ?? new Date(), zone).year
    ? day
    : `${day} ${parts.year}`;
}

/** "01:48" on 24 hours; "01:48:59" with `seconds`. */
export function formatClock(
  at: Date | string,
  options: DateOptions & { readonly seconds?: boolean } = {},
): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const parts = partsOf(date, options.zone ?? 'utc');
  const clock = `${two(parts.hours)}:${two(parts.minutes)}`;
  return options.seconds ? `${clock}:${two(parts.seconds)}` : clock;
}

/** "14 Oct, 01:48": a day and its clock; with `seconds`, "14 Oct, 01:48:59". */
export function formatDayTime(
  at: Date | string,
  options: DateOptions & { readonly seconds?: boolean } = {},
): string {
  const day = formatDay(at, options);
  return day === '' ? '' : `${day}, ${formatClock(at, options)}`;
}

/** "Wednesday 14 October, 02:02": the date a page opens on, said once. */
export function formatToday(at: Date | string, options: DateOptions = {}): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const parts = partsOf(date, options.zone ?? 'utc');
  const day = `${WEEKDAYS[parts.weekday] ?? ''} ${parts.day} ${MONTHS_LONG[parts.month] ?? ''}`;
  return `${day}, ${formatClock(date, options)}`;
}
