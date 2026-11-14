/**
 * The pages of the Activity (its Record and its Timeline): fixed pages, newest
 * first, reached by keyset from the address. Pure: no store, no `next`.
 *
 *   - `?cursor=<position>`: the page strictly older than a position (the last
 *     line of the page before it);
 *   - `?after=<position>`: the page strictly newer than a position (the first
 *     line of the page after it), read oldest first by the store and turned
 *     back here;
 *   - `?at=<n>`: the number of the first line shown, carried by the pager's
 *     own links so that it can say "Lines 51–100". It is a convenience of the
 *     reader's walk, never a position: the keyset decides what is shown, and a
 *     line written meanwhile does not shift a page.
 *
 * A value that cannot be read is dropped and reported; it never widens what a
 * page shows (the first page is shown instead).
 */
import type { AuditCursor } from '../store';
import { decodeCursor } from './filters';

export const PAGE_PARAMS = { older: 'cursor', newer: 'after', at: 'at' } as const;

/** Where a page starts: older than a position, or newer than one. */
export type PagePosition =
  | { readonly direction: 'older'; readonly from: AuditCursor }
  | { readonly direction: 'newer'; readonly from: AuditCursor };

export interface ParsedPage {
  /** `null`: the first page, the newest lines. */
  readonly position: PagePosition | null;
  /** The number of the first line shown, when the pager's own link said it. */
  readonly at: number | null;
  readonly problems: readonly string[];
}

/** Lines are numbered up to this; a larger `at` is not a line number this record holds. */
const MAX_AT = 10_000_000;

type RawQuery = Readonly<Record<string, string | readonly string[] | undefined>>;

function first(query: RawQuery, name: string): string | null {
  const value = query[name];
  const text = Array.isArray(value) ? (value as readonly string[])[0] : value;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function parsePage(query: RawQuery): ParsedPage {
  const problems: string[] = [];
  const read = (param: string): AuditCursor | null => {
    const text = first(query, param);
    if (text === null) return null;
    const cursor = decodeCursor(text);
    if (cursor === null) problems.push(`${param}: unreadable, showing the newest lines`);
    return cursor;
  };
  const older = read(PAGE_PARAMS.older);
  const newer = read(PAGE_PARAMS.newer);
  let position: PagePosition | null = null;
  if (older && newer) {
    problems.push('cursor and after: only one position at a time, showing the newest lines');
  } else if (older) {
    position = { direction: 'older', from: older };
  } else if (newer) {
    position = { direction: 'newer', from: newer };
  }
  const atText = first(query, PAGE_PARAMS.at);
  const atValue = atText !== null && /^\d{1,8}$/.test(atText) ? Number(atText) : null;
  const at =
    position === null ? 1 : atValue !== null && atValue >= 1 && atValue <= MAX_AT ? atValue : null;
  return { position, at, problems };
}

/** The store's keyset option of a position. */
export function keysetOf(position: PagePosition | null): {
  readonly before?: AuditCursor;
  readonly after?: AuditCursor;
} {
  if (position === null) return {};
  return position.direction === 'older' ? { before: position.from } : { after: position.from };
}

/** One page, newest first, and the positions of its neighbours (`null`: none). */
export interface Paged<T> {
  readonly shown: readonly T[];
  /** The page after this one, older: its `cursor`. */
  readonly older: AuditCursor | null;
  /** The page before this one, newer: its `after`. */
  readonly newer: AuditCursor | null;
}

/**
 * A page from what the store returned for `position`, asked with a limit of one
 * more than the page: that extra row says a further page exists in the direction
 * read. The other direction exists when the page was reached from a position
 * (the line it was reached from is there), and the page is not empty.
 */
export function pageOf<T extends { readonly ts: string; readonly id: string }>(
  rows: readonly T[],
  pageSize: number,
  position: PagePosition | null,
): Paged<T> {
  const more = rows.length > pageSize;
  const read = rows.slice(0, pageSize);
  const shown = position?.direction === 'newer' ? [...read].reverse() : read;
  const newest = shown[0];
  const oldest = shown.at(-1);
  const at = (row: T | undefined): AuditCursor | null => (row ? { ts: row.ts, id: row.id } : null);
  if (position?.direction === 'newer') {
    return { shown, newer: more ? at(newest) : null, older: at(oldest) };
  }
  return { shown, older: more ? at(oldest) : null, newer: position ? at(newest) : null };
}
