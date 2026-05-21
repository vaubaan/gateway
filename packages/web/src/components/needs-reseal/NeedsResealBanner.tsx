/**
 * `<NeedsResealBanner>` — top-of-page banner that fetches
 * `GET /api/crm/v1/orgs/:slug/needs-reseal` on mount and renders a
 * "X access blobs need re-sealing" CTA if any row is stale.
 *
 * Spec §4.5 (re-seal flow). The component is **discovery-only** — the
 * actual re-seal action requires unsealing each blob locally, fetching
 * the fresh recipients list, sealing again, and PUTting back. That
 * per-blob handler lives in `re-seal-blob.ts` (sister module), which
 * the banner triggers behind a confirm dialog.
 *
 * The banner does NOT poll. It fetches once on mount; a manual
 * "Refresh" link is provided. After a successful per-blob re-seal,
 * we re-run the fetch.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

import { runReseal, type RunResealResult } from '@/lib/secret-managers/re-seal-blob';

interface NeedsResealItem {
  readonly resource_id: string;
  readonly key: string;
  readonly resource_name: string | null;
}

interface ApiResponse {
  readonly count: number;
  readonly items: ReadonlyArray<NeedsResealItem>;
}

type Status = 'idle' | 'loading' | 'ready' | 'error' | 'resealing';

export interface NeedsResealBannerProps {
  readonly orgSlug: string;
  /**
   * Disable the auto-fetch on mount. Useful for tests that want to
   * call the action manually.
   */
  readonly autoFetch?: boolean;
}

export function NeedsResealBanner(props: NeedsResealBannerProps): React.ReactElement | null {
  const { orgSlug, autoFetch = true } = props;
  const [status, setStatus] = useState<Status>('idle');
  const [items, setItems] = useState<ReadonlyArray<NeedsResealItem>>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    failures: number;
  } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);
    try {
      const res = await fetch(`/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/needs-reseal`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus('error');
        setError(body.error ?? `HTTP ${String(res.status)}`);
        return;
      }
      const body = (await res.json()) as ApiResponse;
      setItems(body.items);
      setStatus('ready');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'unknown_error');
    }
  }, [orgSlug]);

  useEffect(() => {
    if (autoFetch) void load();
  }, [autoFetch, load]);

  const handleReseal = useCallback(async (): Promise<void> => {
    setStatus('resealing');
    setProgress({ done: 0, total: items.length, failures: 0 });
    let done = 0;
    let failures = 0;
    for (const it of items) {
      const r: RunResealResult = await runReseal({
        orgSlug,
        resourceId: it.resource_id,
        accessKey: it.key,
      });
      done += 1;
      if (!r.ok) failures += 1;
      setProgress({ done, total: items.length, failures });
    }
    await load();
  }, [items, orgSlug, load]);

  if (status === 'idle' || status === 'loading') return null;
  if (status === 'ready' && items.length === 0) return null;

  return (
    <aside
      data-testid="needs-reseal-banner"
      data-status={status}
      data-count={String(items.length)}
      role="alert"
      className="border-b border-yellow-300 bg-yellow-50 px-6 py-3 text-sm text-yellow-900"
    >
      {status === 'error' ? (
        <span data-testid="needs-reseal-banner-error">
          Could not check for stale access blobs: {error ?? 'unknown'} ·{' '}
          <button type="button" onClick={() => void load()} className="underline">
            retry
          </button>
        </span>
      ) : null}
      {status === 'ready' && items.length > 0 ? (
        <div className="flex items-center justify-between gap-4">
          <span data-testid="needs-reseal-banner-message">
            {String(items.length)} access blob{items.length > 1 ? 's' : ''} need re-sealing for new
            members.
          </span>
          <button
            type="button"
            data-testid="needs-reseal-banner-action"
            onClick={() => void handleReseal()}
            className="rounded bg-yellow-900 px-3 py-1 text-xs font-semibold text-yellow-50"
          >
            Re-seal now
          </button>
        </div>
      ) : null}
      {status === 'resealing' && progress ? (
        <span data-testid="needs-reseal-banner-progress">
          Re-sealing… {String(progress.done)} / {String(progress.total)}
          {progress.failures > 0 ? ` (${String(progress.failures)} failed)` : ''}
        </span>
      ) : null}
    </aside>
  );
}
