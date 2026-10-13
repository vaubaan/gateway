/**
 * Period arithmetic — pure.
 *
 * Spec §3.3: "the period rollover is computed on read, never by a background task: a
 * call arriving after the end of a period sees the new period's counters at zero".
 * Plan §3.5: "reload for recurring missions is pure arithmetic on
 * `(period_anchor, period_length, now)`; no background job".
 *
 * The store keys counters by `period_start`; this module is the single place that
 * computes it. A one-off mission has exactly one period that starts at its anchor
 * (the issuance time the store records) and never ends.
 */

import type { Iso8601, Period } from '@vaubaan/shared';
import { BudgetInvariantError } from './errors.ts';

const MS_PER_SECOND = 1000;

/** The period of a mission as the budget sees it: an anchor and, for a recurring
 *  mission, a length. The store's `MissionRecord` carries both columns; the shared
 *  `Period` carries the anchor only when recurring. */
export interface PeriodSpec {
  /** Start of the first period. */
  readonly anchor_at: Iso8601;
  /** Length of a period; `null` for a one-off mission (single, open-ended period). */
  readonly length_seconds: number | null;
}

/** The period a given instant falls in. `start` is the counters' key. */
export interface CurrentPeriod {
  /** 0 for the first period (and for every one-off mission). */
  readonly index: number;
  readonly start: Iso8601;
  /** `null` when the period never ends (one-off mission). */
  readonly end: Iso8601 | null;
}

function parseInstant(iso: Iso8601, what: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms))
    throw new BudgetInvariantError(`${what} is not an ISO-8601 instant: '${iso}'`);
  return ms;
}

function assertLength(lengthSeconds: number): void {
  if (!Number.isInteger(lengthSeconds) || lengthSeconds <= 0) {
    throw new BudgetInvariantError(
      `period length must be a positive integer number of seconds (got ${lengthSeconds})`,
    );
  }
}

/**
 * Index of the period containing `now`, counted from the anchor. An instant before the
 * anchor (clock skew between issuance and first call) belongs to the first period.
 */
export function periodIndex(anchorAt: Iso8601, lengthSeconds: number, now: Date): number {
  assertLength(lengthSeconds);
  const anchorMs = parseInstant(anchorAt, 'period anchor');
  const elapsedMs = now.getTime() - anchorMs;
  if (elapsedMs < 0) return 0;
  return Math.floor(elapsedMs / (lengthSeconds * MS_PER_SECOND));
}

/** The period `now` falls in, with its start (the counters' key) and end. */
export function currentPeriod(spec: PeriodSpec, now: Date): CurrentPeriod {
  const anchorMs = parseInstant(spec.anchor_at, 'period anchor');
  if (spec.length_seconds === null) {
    return { index: 0, start: new Date(anchorMs).toISOString(), end: null };
  }
  const index = periodIndex(spec.anchor_at, spec.length_seconds, now);
  const lengthMs = spec.length_seconds * MS_PER_SECOND;
  const startMs = anchorMs + index * lengthMs;
  return {
    index,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + lengthMs).toISOString(),
  };
}

/**
 * The shared `Period` as a `PeriodSpec`. A one-off `Period` carries no anchor, so the
 * caller supplies the one the store recorded at issuance (`MissionRecord.periodAnchor`).
 */
export function periodSpecOf(period: Period, oneOffAnchorAt: Iso8601): PeriodSpec {
  if (period.kind === 'recurring') {
    return { anchor_at: period.anchor_at, length_seconds: period.length_seconds };
  }
  return { anchor_at: oneOffAnchorAt, length_seconds: null };
}
