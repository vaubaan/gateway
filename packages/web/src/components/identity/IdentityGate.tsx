'use client';

/**
 * IdentityGate — client gate that blocks rendering of protected children
 * until the user's crypto identity is unlocked (spec §4.1, browser flow).
 *
 * Logic:
 *   - no Supabase session   → render children (unauth pages should still
 *     mount; protected route layouts redirect to login elsewhere).
 *   - session + state!=='unlocked' → render UnlockIdentityDialog over a
 *     blocking placeholder; children stay unmounted so they cannot read
 *     the (still-absent) identity.
 *   - session + state==='unlocked' → render children.
 *
 * The dialog auto-picks 'first-login' mode on the 1st attempt and falls
 * back to 'unlock' once we know the row exists (HTTP 200 path).
 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createSupabaseBrowserClient } from '@/lib/supabase/client';

import { useUserIdentity } from '@/lib/crypto/use-user-identity';
import { UnlockIdentityDialog } from './UnlockIdentityDialog';

const ENDPOINT = '/api/crm/v1/me/crypto-key';

export function IdentityGate({ children }: { children: ReactNode }): ReactElement | null {
  const { state, unlock, initOrUnlock } = useUserIdentity();
  const [authChecked, setAuthChecked] = useState(false);
  const [hasUser, setHasUser] = useState(false);
  const [mode, setMode] = useState<'unlock' | 'first-login'>('unlock');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = createSupabaseBrowserClient() as SupabaseClient;

    async function check(): Promise<void> {
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      const user = data.user;
      setHasUser(user !== null);
      setAuthChecked(true);
      if (!user) return;
      // Probe the row so the dialog can render the right copy on first
      // paint — the rest of the work happens once the user submits.
      try {
        const res = await fetch(ENDPOINT, { method: 'GET' });
        if (cancelled) return;
        setMode(res.status === 404 ? 'first-login' : 'unlock');
      } catch {
        // Network/probe failures default to 'unlock'; the actual unlock
        // attempt will surface the real error to the user.
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!authChecked) return null;
  if (!hasUser) return <>{children}</>;
  if (state === 'unlocked') return <>{children}</>;

  async function handleSubmit(password: string): Promise<void> {
    setError(null);
    if (mode === 'first-login') {
      await initOrUnlock(password);
    } else {
      await unlock(password);
    }
  }

  return (
    <>
      <UnlockIdentityDialog
        open
        mode={mode}
        onSubmit={handleSubmit}
        onError={(err) => {
          setError(err);
        }}
      />
      {error !== null && (
        <div aria-hidden className="pointer-events-none fixed inset-0" data-identity-blocked />
      )}
    </>
  );
}
