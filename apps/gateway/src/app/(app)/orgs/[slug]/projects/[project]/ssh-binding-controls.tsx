'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui';

export function SshBindingControls({
  hostId,
  hostSlug,
  orgSlug,
}: {
  hostId: string;
  hostSlug: string;
  orgSlug: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function destroy() {
    if (!window.confirm(`Delete the SSH binding "${hostSlug}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/ssh-bindings/${hostId}?orgSlug=${encodeURIComponent(orgSlug)}`,
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
    <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
      <Button
        type="button"
        size="sm"
        variant="danger"
        onClick={() => void destroy()}
        disabled={busy}
      >
        {busy ? 'Deleting…' : 'Delete'}
      </Button>
      {error && (
        <span style={{ color: 'var(--accent-danger-fg)', fontSize: 'var(--text-xs)' }}>
          {error}
        </span>
      )}
    </span>
  );
}
