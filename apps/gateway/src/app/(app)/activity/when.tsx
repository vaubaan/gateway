'use client';

/**
 * The time of a line of the record: the clock time, and the day under it in
 * the quiet ink — a record is read down a column of times. The server renders
 * both in UTC; after hydration they are the reader's own (the same swap as
 * `LocalDate`, without a hydration mismatch). The exact instant is the
 * `dateTime` of the element and its `title`.
 */
import { useEffect, useState } from 'react';

import { shortDate } from '@/lib/vocabulary';

import styles from './activity.module.css';

const TIME_START = 11;
const TIME_END = 19;

export function When({ ts }: { ts: string }) {
  const [local, setLocal] = useState(false);
  useEffect(() => {
    setLocal(true);
  }, []);
  const date = new Date(ts);
  const iso = date.toISOString();
  const time = local
    ? date.toLocaleTimeString(undefined, { hour12: false })
    : iso.slice(TIME_START, TIME_END);
  const day = local
    ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : shortDate(iso, date);
  return (
    <time dateTime={iso} title={iso} className={styles.when} suppressHydrationWarning>
      <span suppressHydrationWarning>{time}</span>
      <span className={styles.sub} suppressHydrationWarning>
        {day}
      </span>
    </time>
  );
}
