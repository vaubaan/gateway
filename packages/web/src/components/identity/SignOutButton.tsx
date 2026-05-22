'use client';

/**
 * SignOutButton — wipes the in-memory crypto identity, then calls
 * supabase.auth.signOut(). Order matters: the sk must be cleared
 * before we release the session, so a redirect cannot leave the
 * unwrapped key reachable from the next page.
 */

import { useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import type { SupabaseClient } from '@supabase/supabase-js';

import { identityStore } from '@/lib/crypto/identity-store';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export function SignOutButton({
  className,
  label = 'Sign out',
}: {
  className?: string;
  label?: string;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function handleClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      identityStore.clear();
      const supabase = createSupabaseBrowserClient() as SupabaseClient;
      await supabase.auth.signOut();
      router.push('/sign-in');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        void handleClick();
      }}
      className={
        className ??
        'rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50'
      }
    >
      {busy ? 'Signing out...' : label}
    </button>
  );
}
