/**
 * A meter is shown **only near a limit**: a number appears where someone would
 * act on it. Below the threshold the component renders a dash (or nothing),
 * so a list of missions shows one bar, the one that matters, and not a column
 * of bars saying "all is well".
 *
 * The threshold is the caller's (`threshold`, a share of the limit): the
 * default view of a list takes the default; a detailed view passes `0` to
 * draw every meter. Near the limit the bar and the figure are ink; at the limit
 * they turn red and say so in words (style guide §5). shadcn/ui's Progress,
 * drawn on the shared tokens.
 */
import { formatNumber, LIMIT_WORDS, usage } from '@/lib/vocabulary';

import { cn } from '@/lib/utils';

/** From this share of the limit on, the default view shows the meter. */
export const NEAR_LIMIT = 0.6;

export type MeterState = 'far' | 'near' | 'reached';

/** Where a count stands against its limit. A limit of zero is reached. */
export function meterState(
  used: number,
  limit: number,
  threshold: number = NEAR_LIMIT,
): MeterState {
  if (limit <= 0 || used >= limit) return 'reached';
  return used / limit >= threshold ? 'near' : 'far';
}

export function Meter({
  used,
  limit,
  threshold = NEAR_LIMIT,
  label,
  format = 'fraction',
  placeholder = 'dash',
}: {
  used: number;
  limit: number;
  /** A share of the limit, 0 to 1. Below it nothing is drawn. `0` always draws. */
  threshold?: number;
  /** What is counted, in words ("branch writes"): said after the figure and to assistive technology. */
  label?: string;
  /** `fraction` — "1,860 / 3,000"; `percent` — "62%". */
  format?: 'fraction' | 'percent';
  /** What stands for a meter that is not shown: a dash that keeps a column aligned, or nothing. */
  placeholder?: 'dash' | 'none';
}) {
  const state = meterState(used, limit, threshold);
  if (state === 'far' && threshold > 0) {
    if (placeholder === 'none') return null;
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="vbn-sr-only">
          {label ? `${label}: ` : ''}
          {usage(used, limit)}, far from the limit
        </span>
      </span>
    );
  }
  const share = limit <= 0 ? 1 : Math.min(used / limit, 1);
  const percent = Math.round(share * 100);
  const figure = format === 'percent' ? `${formatNumber(percent)}%` : usage(used, limit);
  return (
    <span
      className="inline-flex items-center gap-2.5 whitespace-nowrap align-middle text-small tabular-nums text-muted-foreground"
      data-state={state}
    >
      <span
        className="block h-1.5 w-[84px] flex-none overflow-hidden rounded-full bg-muted shadow-[inset_0_0_0_1px_var(--border)]"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        aria-valuetext={`${usage(used, limit)}${label ? ` ${label}` : ''}`}
      >
        <span
          className={cn(
            'block h-full rounded-full',
            state === 'reached'
              ? 'bg-refused'
              : state === 'near'
                ? 'bg-foreground'
                : 'bg-muted-foreground',
          )}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span
        className={cn(
          state === 'reached' && 'font-semibold text-refused-fg',
          state === 'near' && 'font-semibold text-foreground',
        )}
      >
        {figure}
        {label && <span className="font-normal"> {label}</span>}
        {state === 'reached' && <span className="vbn-sr-only"> — {LIMIT_WORDS.limitReached}</span>}
      </span>
    </span>
  );
}
