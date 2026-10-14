'use client';

/**
 * The date and time of the page, said once and in full: "Tuesday 13 October,
 * 11:02", in the form `lib/dates` writes whatever the browser's locale. The
 * server does not know the reader's time zone, so it renders the UTC instant
 * and says so; the browser replaces it after hydration.
 */
import { useEffect, useState } from 'react';

import { formatToday } from '@/lib/dates';

export function Today({ at }: { at: string }) {
  const [local, setLocal] = useState(false);
  useEffect(() => {
    setLocal(true);
  }, []);
  return (
    <time dateTime={at} suppressHydrationWarning data-testid="now-date">
      {local ? formatToday(at, { zone: 'local' }) : `${formatToday(at)} UTC`}
    </time>
  );
}
