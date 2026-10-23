/**
 * How many lines of the record the Activity page shows: `?lines=<n>`, always a
 * whole number of pages of the search. Scrolling to the end of the list (or
 * "Load earlier") asks the same page for one page more; the server reads the
 * record again from the same position (the newest line, or `?cursor=`) with a
 * longer page, through the same `AuditQueryService.search(principal, …)`.
 *
 * Pure: no store, no `next`. A value that cannot be read falls back to one
 * page; a value above the ceiling is held at it. Past the ceiling the page
 * stops growing and offers to continue from the last line shown (`cursor`),
 * so one address never re-reads more than `MAX_LINES` lines.
 */

/** The query parameter: how many lines are shown. */
export const LINES_PARAM = 'lines';

/** The ceiling of one address, in pages. */
export const MAX_PAGES = 20;

/** The lines shown at `value`, for pages of `pageSize` lines. */
export function parseLines(value: string | null, pageSize: number): number {
  if (value === null || !/^\d{1,6}$/.test(value)) return pageSize;
  const asked = Number(value);
  const pages = Math.ceil(asked / pageSize);
  return Math.min(Math.max(pages, 1), MAX_PAGES) * pageSize;
}

/** The `lines` of the next step, or `null` when the ceiling is reached. */
export function moreLines(lines: number, pageSize: number): number | null {
  const next = lines + pageSize;
  return next > pageSize * MAX_PAGES ? null : next;
}

/** The value to write in an address: nothing for the first page, which is the default. */
export function linesValue(lines: number, pageSize: number): string | null {
  return lines > pageSize ? String(lines) : null;
}
