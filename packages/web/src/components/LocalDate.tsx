'use client';

/**
 * Renders a timestamp in the user's locale without causing a hydration
 * mismatch.
 *
 * Why : `new Date(...).toLocaleString()` returns a *different string* on the
 * server (UTC, en-US default) vs the client (browser timezone + locale), which
 * triggers React error #418 ("Text content does not match server-rendered
 * HTML.") on hydration.
 *
 * How : SSR renders the deterministic ISO form (`YYYY-MM-DD HH:mm:ss` or just
 * the date). After hydration, useEffect swaps it for `toLocaleString()`.
 * `suppressHydrationWarning` covers the brief moment when React reconciles.
 */

import { useEffect, useState } from 'react';

export function LocalDate({
  ts,
  dateOnly = false,
}: {
  ts: string | null | undefined;
  /** Render just the date (no time). */
  dateOnly?: boolean;
}) {
  const [isClient, setIsClient] = useState(false);
  useEffect(() => {
    setIsClient(true);
  }, []);
  if (!ts) return null;

  const d = new Date(ts);
  const text = isClient
    ? dateOnly
      ? d.toLocaleDateString()
      : d.toLocaleString()
    : d
        .toISOString()
        .replace('T', ' ')
        .slice(0, dateOnly ? 10 : 19);

  return <span suppressHydrationWarning>{text}</span>;
}
