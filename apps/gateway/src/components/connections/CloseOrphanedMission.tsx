'use client';

/**
 * "Close" on an orphaned mission, for an owner of one of its connections (spec
 * §2.3: "the creator, or an owner of the connection, may close it"). Closing is
 * the mission's revocation — same route, same entry in the audit — and is
 * final, so the owner types the mission's name first.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, DangerConfirm } from '@/components/ui';

function messageOf(body: unknown, status: number): string {
  // The API answers "not found" to whoever may not close the mission: say what changed.
  if (status === 404) {
    return 'This mission is no longer orphaned, or is no longer on a connection you own.';
  }
  if (typeof body === 'object' && body !== null && 'message' in body) {
    if (typeof body.message === 'string') return body.message;
  }
  return 'The instance answered ' + String(status) + '.';
}

export function CloseOrphanedMission({ missionId, name }: { missionId: string; name: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function close(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/revoke`, {
        method: 'POST',
      });
      if (!res.ok) {
        setError(messageOf(await res.json().catch(() => null), res.status));
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch {
      setError('The instance could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={() => setConfirming(true)}
        disabled={busy}
        aria-label={`Close mission ${name}`}
      >
        Close
      </Button>
      {confirming && (
        <DangerConfirm
          title="Close this orphaned mission"
          body="The mission is revoked: every token of it stops for good, and no share brings it back. Its creator issues a new mission to continue the work."
          phrase={name}
          confirmLabel="Close mission"
          busy={busy}
          error={error}
          onCancel={() => {
            setConfirming(false);
            setError(null);
          }}
          onConfirm={() => void close()}
        />
      )}
    </>
  );
}
