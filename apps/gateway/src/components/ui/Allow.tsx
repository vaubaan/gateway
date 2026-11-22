/**
 * What a mission allows, in three lines a person reads before anything else:
 * **Can · Asks you first · Cannot**, and — when one limit is near — a fourth,
 * "Limits today". The first thing on a mission page and the content of the
 * rail while one is created.
 *
 * It is a summary of an explicit list, never a replacement for it: the count
 * of permissions is said, and the list is one click away.
 *
 * `AllowSummary` is the wide form (a definition list, capped at the prose
 * measure); `compact` is the form of the rail (narrower labels, smaller text).
 */
import { cn } from '@/lib/utils';
import { ALLOW_WORDS } from '@/lib/vocabulary';

/** A line of the summary: its term and its value sit in the grid of the list. */
const LINE = 'contents [&>dt]:whitespace-nowrap';

export function AllowSummary({
  can,
  asks,
  cannot,
  limits,
  asksLabel = ALLOW_WORDS.asks,
  compact = false,
  testId,
}: {
  /** What runs freely, as a sentence. */
  can: React.ReactNode;
  /** What asks first; `null` when nothing does (the line is then left out). */
  asks?: React.ReactNode;
  /** What is not in the mission and is therefore refused. */
  cannot: React.ReactNode;
  /** The one limit near its end today (a `Meter` and a few words). */
  limits?: React.ReactNode;
  /** "Asks you first", or "Asks Alice first" on someone else's mission (`asksFirst`). */
  asksLabel?: string;
  compact?: boolean;
  testId?: string;
}) {
  return (
    <dl
      className={cn(
        // The label column grows with its longest label: a label never runs under its value.
        'm-0 grid max-w-(--measure) text-small max-[720px]:grid-cols-1 max-[720px]:gap-0',
        '[&_dd]:m-0 [&_dd]:text-muted-foreground max-[720px]:[&_dd]:mb-2 [&_dd_a]:text-primary [&_dd_b]:font-normal [&_dd_b]:text-foreground [&_dd_strong]:font-normal [&_dd_strong]:text-foreground',
        compact
          ? 'grid-cols-[62px_minmax(0,1fr)] gap-x-2 gap-y-1'
          : 'grid-cols-[minmax(110px,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5',
      )}
      data-testid={testId}
    >
      <div className={LINE}>
        <dt>{ALLOW_WORDS.can}</dt>
        <dd>{can}</dd>
      </div>
      {asks && (
        // The one coloured line: something here waits for a person.
        <div className={cn(LINE, '[&>dt]:text-approval-fg')}>
          <dt>{asksLabel}</dt>
          <dd>{asks}</dd>
        </div>
      )}
      <div className={cn(LINE, '[&>dt]:text-muted-foreground')}>
        <dt>{ALLOW_WORDS.cannot}</dt>
        <dd>{cannot}</dd>
      </div>
      {limits && (
        <div className={cn(LINE, '[&>dt]:text-muted-foreground')}>
          <dt>{ALLOW_WORDS.limits}</dt>
          <dd>{limits}</dd>
        </div>
      )}
    </dl>
  );
}
