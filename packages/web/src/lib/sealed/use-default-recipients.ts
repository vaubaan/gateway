/**
 * `useDefaultRecipients(resourceId, accessKey)` — cached fetcher for the
 * default recipient list (spec §4.4). Backed by
 * `GET /api/crm/v1/resources/:rId/access/:key/recipients` (Phase 2).
 *
 * Cache key = `${resourceId}::${accessKey}`. The cache is module-level
 * (not localStorage / sessionStorage / IndexedDB — those are forbidden
 * by the ZK invariant; the recipients themselves are not secret but we
 * still want the values to die with the tab). Cache TTL is short
 * (60 s) so a membership change picked up by Phase 6 is reflected on
 * the next seal.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { base64ToBytes } from './base64';

export interface RecipientWire {
  readonly user_id?: string;
  readonly public_key: string; // base64
  readonly fingerprint: string;
}

export interface RecipientEntry {
  readonly userId?: string;
  readonly publicKey: Uint8Array;
  readonly fingerprint: string;
}

interface CacheEntry {
  readonly at: number;
  readonly recipients: ReadonlyArray<RecipientEntry>;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

export interface UseDefaultRecipientsState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly recipients: ReadonlyArray<RecipientEntry>;
  readonly error: string | null;
  refresh(): Promise<void>;
}

export function useDefaultRecipients(
  resourceId: string,
  accessKey: string,
): UseDefaultRecipientsState {
  const [status, setStatus] = useState<UseDefaultRecipientsState['status']>('idle');
  const [recipients, setRecipients] = useState<ReadonlyArray<RecipientEntry>>([]);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  const fetcher = useCallback(
    async (force: boolean) => {
      const key = `${resourceId}::${accessKey}`;
      if (!force) {
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < TTL_MS) {
          setRecipients(hit.recipients);
          setStatus('ready');
          setError(null);
          return;
        }
      }
      setStatus('loading');
      try {
        const res = await fetch(
          `/api/crm/v1/resources/${encodeURIComponent(resourceId)}/access/${encodeURIComponent(
            accessKey,
          )}/recipients`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          const text = (await res.json().catch(() => ({}))) as { error?: string };
          if (!aliveRef.current) return;
          setStatus('error');
          setError(text.error ?? `HTTP ${String(res.status)}`);
          return;
        }
        const body = (await res.json()) as { defaults: ReadonlyArray<RecipientWire> };
        const decoded: RecipientEntry[] = body.defaults.map((w) => ({
          userId: w.user_id,
          publicKey: base64ToBytes(w.public_key),
          fingerprint: w.fingerprint,
        }));
        cache.set(key, { at: Date.now(), recipients: decoded });
        if (!aliveRef.current) return;
        setRecipients(decoded);
        setStatus('ready');
        setError(null);
      } catch (e) {
        if (!aliveRef.current) return;
        setStatus('error');
        setError(e instanceof Error ? e.message : 'unknown_error');
      }
    },
    [resourceId, accessKey],
  );

  useEffect(() => {
    aliveRef.current = true;
    void fetcher(false);
    return () => {
      aliveRef.current = false;
    };
  }, [fetcher]);

  const refresh = useCallback(async (): Promise<void> => {
    await fetcher(true);
  }, [fetcher]);

  return { status, recipients, error, refresh };
}

/** Test-only escape hatch — clear the module-level cache between scenarios. */
export function __resetDefaultRecipientsCache(): void {
  cache.clear();
}
