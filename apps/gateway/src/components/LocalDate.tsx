'use client';

/**
 * An instant in the reader's time zone, in the one form the interface writes
 * dates in (`lib/dates`): "14 Oct, 01:48", "14 Oct" with `dateOnly`,
 * "14 Oct, 01:48:59" with `seconds`. Never the browser's locale: a page reads
 * the same whatever language the browser is set to.
 *
 * The server does not know the reader's zone: it renders the instant in UTC,
 * and the browser replaces it with the reader's own after hydration.
 * `suppressHydrationWarning` covers the moment React reconciles the two. The
 * exact instant is the element's `dateTime` and its `title`.
 */
import { useEffect, useState } from 'react';

import { formatDay, formatDayTime } from '@/lib/dates';

export function LocalDate({
  ts,
  dateOnly = false,
  seconds = false,
}: {
  ts: string | null | undefined;
  /** The day alone: "14 Oct". */
  dateOnly?: boolean;
  /** The clock to the second, where a record is read line by line. */
  seconds?: boolean;
}) {
  const [local, setLocal] = useState(false);
  useEffect(() => {
    setLocal(true);
  }, []);
  if (!ts) return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;

  const zone = local ? 'local' : 'utc';
  const text = dateOnly ? formatDay(date, { zone }) : formatDayTime(date, { zone, seconds });
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()} suppressHydrationWarning>
      {text}
    </time>
  );
}
