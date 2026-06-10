'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui';

/**
 * Standardised controls for a bash binding row on the project page :
 * mirrors the Edit / Delete pattern used by other provider bindings.
 * Edit navigates to the detail page (the script is too large for an
 * inline edit) ; Delete cascades to all attached hosts.
 */
export function BashBindingControls({
  bindingId,
  displayName,
  orgSlug,
  detailHref,
}: {
  bindingId: string;
  displayName: string;
  orgSlug: string;
  detailHref: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function destroy() {
    if (
      !window.confirm(
        `Delete the bash binding "${displayName}"? All attached hosts will be detached.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/bash-bindings/${bindingId}?orgSlug=${encodeURIComponent(orgSlug)}`,
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
      <Link href={detailHref} style={{ textDecoration: 'none' }}>
        <Button type="button" size="sm" variant="ghost">
          Edit
        </Button>
      </Link>
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
