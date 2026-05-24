'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function BindingDeleteButton({
  bindingId,
  orgSlug,
}: {
  bindingId: string;
  orgSlug: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function destroy() {
    if (!confirm('Delete this binding? Bots in this project will no longer reach this resource.'))
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/bindings/${bindingId}?orgSlug=${encodeURIComponent(orgSlug)}`,
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
        onClick={destroy}
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
        {busy ? 'Deleting…' : 'Delete'}
      </button>
      {error && <span style={{ color: '#ff7e7e', marginLeft: 8, fontSize: 12 }}>{error}</span>}
    </>
  );
}
