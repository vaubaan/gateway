'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  tokenId: string;
  tokenName: string;
  orgSlug: string;
  status: 'active' | 'revoked';
}

export function TokenRowControls({ tokenId, tokenName, orgSlug, status }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (!window.confirm(`Revoke "${tokenName}" ? The api_key will stop working immediately.`)) {
      return;
    }
    setError(null);
    const res = await fetch(`/api/v1/tokens/${tokenId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug, status: 'revoked' }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `HTTP ${res.status}`);
      return;
    }
    startTransition(() => router.refresh());
  }

  async function destroy() {
    if (
      !window.confirm(
        `Delete "${tokenName}" permanently ? This removes the row from DB ` +
          `(audit log entries stay). Prefer Revoke unless you need to clean up.`,
      )
    ) {
      return;
    }
    setError(null);
    const res = await fetch(`/api/v1/tokens/${tokenId}?orgSlug=${encodeURIComponent(orgSlug)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `HTTP ${res.status}`);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {status === 'active' && (
        <button
          type="button"
          onClick={revoke}
          disabled={pending}
          style={{
            padding: '4px 10px',
            background: 'transparent',
            color: '#dc2626',
            border: '1px solid #dc2626',
            borderRadius: 4,
            fontSize: 12,
            cursor: pending ? 'wait' : 'pointer',
            opacity: pending ? 0.5 : 1,
          }}
          title="Set status=revoked. Keeps the row in DB."
        >
          Revoke
        </button>
      )}
      <button
        type="button"
        onClick={destroy}
        disabled={pending}
        style={{
          padding: '4px 10px',
          background: 'transparent',
          color: 'var(--muted, #888)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          fontSize: 12,
          cursor: pending ? 'wait' : 'pointer',
          opacity: pending ? 0.5 : 1,
        }}
        title="Permanently delete the token row. Audit log entries survive."
      >
        Delete
      </button>
      {error && <span style={{ color: '#dc2626', fontSize: 12, marginLeft: 8 }}>{error}</span>}
    </div>
  );
}
