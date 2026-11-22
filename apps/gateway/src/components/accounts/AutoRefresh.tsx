'use client';

/**
 * Accounts refresh themselves on open (spec §4.2 "Accounts"; handbook accounts): a page
 * that shows accounts whose last refresh is stale renders at once with what is stored,
 * and this asks the gateway to refresh them (`POST /api/accounts/refresh`). While it
 * runs it reads "Refreshing…"; when an account changed, the page reads itself again
 * (`router.refresh()`), in place, without a reload. Without JavaScript the page simply
 * shows what is stored and when it was updated.
 *
 * `accountIds` are the stale ones the server found (`AccountRefresher.staleAmong`);
 * empty, it renders nothing and asks nothing. `quiet` keeps the marker for screen
 * readers only (a form where the accounts are not on screen yet).
 */
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { postJson } from '@/lib/http/post-json';
import { ACCOUNT_WORDS } from '@/lib/vocabulary';

import styles from './account.styles';

export const ACCOUNTS_REFRESH_URL = '/api/accounts/refresh';

function changedOf(body: unknown): readonly unknown[] {
  if (typeof body !== 'object' || body === null) return [];
  const changed = (body as { changed?: unknown }).changed;
  return Array.isArray(changed) ? changed : [];
}

export function AutoRefresh({
  accountIds,
  quiet = false,
}: {
  accountIds: readonly string[];
  quiet?: boolean;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(accountIds.length > 0);
  // One request per set of accounts, even when React mounts the effect twice.
  const asked = useRef<string | null>(null);
  const key = accountIds.join(',');

  useEffect(() => {
    if (key === '' || asked.current === key) return;
    asked.current = key;
    setRunning(true);
    void postJson(ACCOUNTS_REFRESH_URL, { account_ids: key.split(',') }).then((answer) => {
      setRunning(false);
      if (answer.ok && changedOf(answer.body).length > 0) router.refresh();
    });
  }, [key, router]);

  if (!running) return null;
  return (
    <span
      role="status"
      className={quiet ? 'vbn-sr-only' : styles.refreshing}
      data-testid="auto-refresh"
    >
      {ACCOUNT_WORDS.refreshing}
    </span>
  );
}
