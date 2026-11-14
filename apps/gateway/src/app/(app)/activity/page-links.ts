/**
 * The links of the Activity's pager, for its two tabs: where the newer, the
 * older and the newest page are, as addresses (`server/audit/paging.ts`). Pure.
 *
 * A link carries its position (`cursor` or `after`) and the number of its
 * first line (`at`) when the current page knows its own; the filters are the
 * caller's, and so is anything else the address keeps (an open detail).
 */
import { encodeCursor } from '@/server/audit/filters';
import { PAGE_PARAMS, type PagePosition, type Paged } from '@/server/audit/paging';

/** A page of the record as an address holds it. */
export interface PageLink {
  /** `null`: the newest lines. */
  readonly position: PagePosition | null;
  /** The number of its first line, when known. */
  readonly at: number | null;
}

export const NEWEST: PageLink = { position: null, at: 1 };

/** Writes a page into the parameters of an address (the newest page writes nothing). */
export function setPage(params: URLSearchParams, link: PageLink): void {
  params.delete(PAGE_PARAMS.older);
  params.delete(PAGE_PARAMS.newer);
  params.delete(PAGE_PARAMS.at);
  if (link.position === null) return;
  const name = link.position.direction === 'older' ? PAGE_PARAMS.older : PAGE_PARAMS.newer;
  params.set(name, encodeCursor(link.position.from));
  if (link.at !== null) params.set(PAGE_PARAMS.at, String(link.at));
}

export interface Neighbours {
  readonly newer: PageLink | null;
  readonly older: PageLink | null;
  /** The newest page, offered from any other page. */
  readonly newest: PageLink | null;
}

/** The pages around `current`, which shows `shown` lines of pages of `pageSize`. */
export function neighboursOf(
  paged: Pick<Paged<unknown>, 'older' | 'newer'>,
  current: PageLink,
  shown: number,
  pageSize: number,
): Neighbours {
  const { at } = current;
  return {
    newer: paged.newer
      ? {
          position: { direction: 'newer', from: paged.newer },
          at: at === null ? null : Math.max(1, at - pageSize),
        }
      : null,
    older: paged.older
      ? { position: { direction: 'older', from: paged.older }, at: at === null ? null : at + shown }
      : null,
    newest: current.position === null ? null : NEWEST,
  };
}

/** "Lines 51–100", or "50 lines" when the page does not know where it starts. */
export function linesWords(at: number | null, shown: number): string {
  if (shown === 0) return 'No line';
  if (at === null) return `${shown} ${shown === 1 ? 'line' : 'lines'}`;
  return shown === 1 ? `Line ${at}` : `Lines ${at}–${at + shown - 1}`;
}
