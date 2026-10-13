'use client';

/**
 * The date and time of the page, in the reader's own words: "Tuesday 13
 * October, 11:02". The server does not know the reader's time zone, so it
 * renders the UTC instant and the browser replaces it after hydration.
 */
import { useEffect, useState } from 'react';

function utcText(at: string): string {
  return `${at.slice(0, 16).replace('T', ' ')} UTC`;
}

function localText(at: string): string {
  const date = new Date(at);
  const day = date.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

export function Today({ at }: { at: string }) {
  const [local, setLocal] = useState(false);
  useEffect(() => {
    setLocal(true);
  }, []);
  return (
    <time dateTime={at} suppressHydrationWarning data-testid="now-date">
      {local ? localText(at) : utcText(at)}
    </time>
  );
}
