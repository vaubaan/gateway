/**
 * The free slots of a window, from the busy blocks Google's freeBusy.query
 * answers (`calendars.<id>.busy[]`, each `start` inclusive, `end`
 * exclusive). Pure: no clock, no network.
 *
 * Handbook : docs/handbook/services/google-calendar.md (`suggest_time`).
 */

/** A span of time, in milliseconds since the epoch, `start` inclusive, `end` exclusive. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * The busy blocks clipped to the window, sorted and merged: overlapping or
 * touching blocks become one. Blocks that are empty or outside the window
 * are dropped.
 */
export function mergedBusy(window: Span, busy: readonly Span[]): Span[] {
  const clipped = busy
    .map((b) => ({ start: Math.max(b.start, window.start), end: Math.min(b.end, window.end) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const block of clipped) {
    const last = merged.at(-1);
    if (last !== undefined && block.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, block.end) };
    } else {
      merged.push(block);
    }
  }
  return merged;
}

/**
 * The gaps between busy blocks inside `window` that last at least
 * `durationMs`, in order, at most `max` of them. Each gap is free for every
 * person whose blocks were given.
 */
export function freeSlots(
  window: Span,
  busy: readonly Span[],
  durationMs: number,
  max: number,
): Span[] {
  if (window.end <= window.start || durationMs <= 0 || max <= 0) return [];
  const slots: Span[] = [];
  let cursor = window.start;
  for (const block of [...mergedBusy(window, busy), { start: window.end, end: window.end }]) {
    if (block.start - cursor >= durationMs) {
      slots.push({ start: cursor, end: block.start });
      if (slots.length >= max) break;
    }
    cursor = Math.max(cursor, block.end);
  }
  return slots;
}
