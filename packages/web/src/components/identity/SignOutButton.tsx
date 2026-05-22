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

import { Button } from '@/components/ui';
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
    <Button
      type="button"
      variant="secondary"
      size="sm"
      loading={busy}
      onClick={() => {
        void handleClick();
      }}
      className={className}
    >
      {busy ? 'Signing out...' : label}
    </Button>
  );
}
