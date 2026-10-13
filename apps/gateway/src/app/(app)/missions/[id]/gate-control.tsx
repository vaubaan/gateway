'use client';

/**
 * The gate of one accepted risk, edited after issuance (spec §3.5: "the
 * creator sets the risk's gate to `approval` at issuance, or later"). One
 * button per row: it names the gate the risk would get, posts the edit and
 * reloads the page's data. The edit applies to the next call.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui';
import type { Gate } from '@vaubaan/shared';

import { messageOf } from '../message-of';
import styles from '../missions.module.css';

const NEXT_GATE: Readonly<Record<Gate, Gate>> = { auto: 'approval', approval: 'auto' };
const ACTION: Readonly<Record<Gate, string>> = {
  auto: 'Require approval',
  approval: 'Set to auto',
};

export function GateControl({
  missionId,
  riskId,
  gate,
}: {
  missionId: string;
  riskId: string;
  gate: Gate;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${missionId}/gate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ risk_id: riskId, gate: NEXT_GATE[gate] }),
      });
      if (!res.ok) {
        setError(messageOf(await res.json().catch(() => null), res.status));
        return;
      }
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
        size="sm"
        onClick={change}
        disabled={busy}
        aria-label={`${ACTION[gate]} for ${riskId}`}
      >
        {ACTION[gate]}
      </Button>
      {error && <span className={styles.refused}>{error}</span>}
    </>
  );
}
