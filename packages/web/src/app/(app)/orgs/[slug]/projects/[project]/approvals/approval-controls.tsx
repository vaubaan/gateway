'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

export function ApprovalControls({
  projectId,
  approvalId,
  orgSlug,
}: {
  projectId: string;
  approvalId: string;
  orgSlug: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'deny') {
    if (!window.confirm(`Confirm ${decision}?`)) return;
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/approvals/${approvalId}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, decision }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={() => decide('approve')}
        disabled={busy !== null}
      >
        {busy === 'approve' ? '…' : '✅ Approve'}
      </Button>
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={() => decide('deny')}
        disabled={busy !== null}
      >
        {busy === 'deny' ? '…' : '❌ Deny'}
      </Button>
      {error && <span style={{ color: 'var(--accent-danger-fg)', fontSize: 13 }}>{error}</span>}
    </div>
  );
}
