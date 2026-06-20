'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ProviderDisconnectButton({
  orgSlug,
  provider,
}: {
  orgSlug: string;
  provider: 'github' | 'vercel' | 'supabase' | 'railway' | 'stripe';
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function disconnect() {
    if (
      !confirm(
        `Disconnect ${provider}? All bots of this org will be denied for ${provider} calls. The stored token is wiped.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/providers/${provider}?orgSlug=${encodeURIComponent(orgSlug)}`,
        { method: 'DELETE' },
      );
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={disconnect}
        disabled={busy}
        style={{
          padding: '4px 10px',
          background: 'transparent',
          color: '#ff7e7e',
          border: '1px solid #4a1c1c',
          borderRadius: 4,
          fontSize: 12,
        }}
      >
        {busy ? 'Disconnecting…' : 'Disconnect'}
      </button>
      {error && <span style={{ color: '#ff7e7e', marginLeft: 8, fontSize: 12 }}>{error}</span>}
    </>
  );
}
