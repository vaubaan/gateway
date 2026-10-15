/**
 * An instant said relative to the moment the page was rendered — "created
 * 2 h ago" — in the one form the interface writes it (`agoSentence`). The
 * exact instant is the element's `dateTime`, and its day and clock (`lib/dates`,
 * UTC: the server does not know the reader's zone) are its `title`, so that
 * two things made the same day can still be told apart.
 *
 * A server component: the relative words depend on `now`, which the page
 * passes once so that every instant of a page is read from the same moment.
 */
import { formatDayTime } from '@/lib/dates';
import { agoSentence } from '@/lib/vocabulary';

export function RelativeTime({
  at,
  now,
  prefix,
  testId,
}: {
  at: string;
  now: Date;
  /** The word before the relative part: "created". */
  prefix?: string;
  testId?: string;
}) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const relative = agoSentence(date, now);
  return (
    <time
      dateTime={date.toISOString()}
      title={`${formatDayTime(date, { now })} UTC`}
      data-testid={testId}
    >
      {prefix ? `${prefix} ${relative}` : relative}
    </time>
  );
}
