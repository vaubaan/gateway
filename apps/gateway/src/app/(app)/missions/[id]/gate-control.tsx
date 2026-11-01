'use client';

/**
 * "Ask me first" for one permission, changed after the mission was created
 * (spec §3.5: "the creator sets the risk's gate to `approval` at issuance, or
 * later"). A switch labelled by what happens: on, the agent must ask before
 * each use; off, the permission runs freely. The change applies to the next
 * call, and the page says so when it is done.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Switch, useToast } from '@/components/ui';
import { GATE_WORDS } from '@/lib/vocabulary';
import type { Gate } from '@vaubaan/shared';

import { useAction } from '@/lib/http/post-json';
import styles from '../missions.module.css';

export function GateControl({
  missionId,
  riskId,
  resourceSetId,
  setSuffix = '',
  label,
  gate,
}: {
  missionId: string;
  /** The protocol's id of the permission: what the API takes. */
  riskId: string;
  /** The resource set of the line (risk model §4.7). */
  resourceSetId?: string;
  /** Tells the switches of one risk in two sets apart ("-set2"); none for the first. */
  setSuffix?: string;
  /** What the permission lets an agent do, for the confirmation. */
  label: string;
  gate: Gate;
}) {
  const router = useRouter();
  const toast = useToast();
  const { busy, error, run } = useAction();
  // The switch moves at once and comes back if the gateway refuses: what it shows while
  // the request is under way is what was asked, never a third state.
  const [asked, setAsked] = useState<Gate | null>(null);
  useEffect(() => setAsked(null), [gate]);

  async function change(next: Gate) {
    setAsked(next);
    const answer = await run(`/api/missions/${encodeURIComponent(missionId)}/gate`, {
      risk_id: riskId,
      ...(resourceSetId ? { resource_set_id: resourceSetId } : {}),
      gate: next,
    });
    if (!answer.ok) {
      setAsked(null);
      return;
    }
    toast({
      title: next === 'approval' ? `“${label}” asks you first` : `“${label}” runs freely`,
      description: 'From the next call.',
    });
    router.refresh();
  }

  return (
    <>
      <Switch
        checked={(asked ?? gate) === 'approval'}
        disabled={busy}
        aria-label={`${GATE_WORDS.ask}: ${riskId}${setSuffix}`}
        data-testid={`gate-switch-${riskId}${setSuffix}`}
        onChange={(event) => void change(event.target.checked ? 'approval' : 'auto')}
      />
      {error && (
        <span className={styles.refused} role="alert">
          {error}
        </span>
      )}
    </>
  );
}
