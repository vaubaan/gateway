'use client';

/**
 * "Close" on a mission that stopped for want of an owner (the protocol's
 * `orphaned`), for an owner of one of its accounts (spec §2.3: "the creator,
 * or an owner of the connection, may close it"). Closing is the mission's
 * revocation — same route, same entry in the activity — and is final, so the
 * owner types the mission's name first.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, DangerConfirm } from '@/components/ui';
import { useAction, type PostAnswer } from '@/lib/http/post-json';
import { ACCOUNT_ACTIONS } from '@/lib/vocabulary';

/** The API answers "not found" to whoever may not close the mission: say what changed. */
function refusalOf(answer: Extract<PostAnswer, { ok: false }>): string {
  return answer.status === 404
    ? 'This mission runs again, or is no longer on an account you own.'
    : answer.message;
}

export function CloseOrphanedMission({ missionId, name }: { missionId: string; name: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const { busy, error, setError, run } = useAction();

  async function close(): Promise<void> {
    const answer = await run(`/api/missions/${encodeURIComponent(missionId)}/revoke`, undefined, {
      errorOf: refusalOf,
    });
    if (!answer.ok) return;
    setConfirming(false);
    router.refresh();
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
        {ACCOUNT_ACTIONS.closeMission}
      </Button>
      {confirming && (
        <DangerConfirm
          title={`Close ${name}?`}
          body="The mission is stopped for good: every key of it is refused from now on, and giving access again will not bring it back. Its creator writes a new mission to continue the work."
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
