'use client';

/**
 * The time of an event, short: "10:58" in the reader's time zone, the full
 * date in its `title`. The server renders the UTC time and the browser
 * replaces it after hydration (the same rule as `LocalDate`).
 */
import { useEffect, useState } from 'react';

export function LocalTime({ ts }: { ts: string }) {
  const [local, setLocal] = useState(false);
  useEffect(() => {
    setLocal(true);
  }, []);
  const date = new Date(ts);
  return (
    <time dateTime={ts} title={local ? date.toLocaleString() : ts} suppressHydrationWarning>
      {local
        ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : ts.slice(11, 16)}
    </time>
  );
}
