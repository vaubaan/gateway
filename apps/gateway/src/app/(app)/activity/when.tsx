'use client';

/**
 * The time of a line of the record: the clock time, and the day under it in
 * the quiet ink — a record is read down a column of times. Both are written
 * by `lib/dates`, the one form of the interface ("01:48:59" over "14 Oct"),
 * whatever the browser's locale. The server renders them in UTC; after
 * hydration they are the reader's own (the same swap as `LocalDate`, without
 * a hydration mismatch). The exact instant is the `dateTime` of the element
 * and its `title`.
 */
import { useEffect, useState } from 'react';

import { formatClock, formatDay } from '@/lib/dates';

import styles from './activity.module.css';

export function When({ ts }: { ts: string }) {
  const [local, setLocal] = useState(false);
  useEffect(() => {
    setLocal(true);
  }, []);
  const date = new Date(ts);
  const iso = date.toISOString();
  const zone = local ? 'local' : 'utc';
  return (
    <time dateTime={iso} title={iso} className={styles.when} suppressHydrationWarning>
      <span suppressHydrationWarning>{formatClock(date, { zone, seconds: true })}</span>
      <span className={styles.sub} suppressHydrationWarning>
        {formatDay(date, { zone })}
      </span>
    </time>
  );
}
