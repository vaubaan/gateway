'use client';

/**
 * The time of an event, short: "10:58" in the reader's time zone, on 24 hours
 * whatever the browser's locale (`lib/dates`), the exact instant in its
 * `title`. The server renders the UTC time and the browser replaces it after
 * hydration (the same rule as `LocalDate`).
 */
import { useEffect, useState } from 'react';

import { formatClock } from '@/lib/dates';

export function LocalTime({ ts }: { ts: string }) {
  const [local, setLocal] = useState(false);
  useEffect(() => {
    setLocal(true);
  }, []);
  return (
    <time dateTime={ts} title={ts} suppressHydrationWarning>
      {formatClock(ts, { zone: local ? 'local' : 'utc' })}
    </time>
  );
}
