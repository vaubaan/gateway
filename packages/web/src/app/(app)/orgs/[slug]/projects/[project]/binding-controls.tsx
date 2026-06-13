'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Provider } from '@vaubaan/shared';
import { Button } from '@/components/ui';

interface Binding {
  id: string;
  provider: Provider;
  resource_ref: string;
  display_name: string | null;
  environment: string | null;
}

export function BindingControls({
  binding,
  orgSlug,
  projectSlug,
}: {
  binding: Binding;
  orgSlug: string;
  projectSlug: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function destroy() {
    if (
      !window.confirm(
        `Delete the ${binding.provider} binding to ${binding.display_name ?? binding.resource_ref}? Access tokens in this project will no longer reach this resource.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/bindings/${binding.id}?orgSlug=${encodeURIComponent(orgSlug)}`,
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
        variant="ghost"
        onClick={() =>
          router.push(`/orgs/${orgSlug}/projects/${projectSlug}/bindings/${binding.id}/edit`)
        }
      >
        Edit
      </Button>
      <Button type="button" size="sm" variant="danger" onClick={destroy} disabled={busy}>
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
