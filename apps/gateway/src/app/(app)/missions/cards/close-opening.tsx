'use client';

/**
 * "Close" beside a permission that runs freely until the reset (spec §3.5: the creator
 * opened its gate for the rest of the period): its gate stays "ask me first" and the
 * opening ends, so the next call asks again. The same act as before the card redesign —
 * `POST /api/missions/:id/gate` with `approval`, which the service turns into closing
 * the opening (`setGate`, `closeOpening`) — offered to the creator only, in the hover
 * of the mission page's gauge.
 */
import { useRouter } from 'next/navigation';

import { useToast } from '@/components/ui';
import { CARD_WORDS } from '@/lib/vocabulary';
import { useAction } from '@/lib/http/post-json';

import styles from './cards.styles';

export function CloseOpening({
  missionId,
  riskId,
  resourceSetId,
  label,
}: {
  missionId: string;
  riskId: string;
  resourceSetId: string;
  /** What the permission lets an agent do, for the confirmation. */
  label: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const { busy, error, run } = useAction();
  return (
    <>
      <button
        type="button"
        className={styles.checkNow}
        disabled={busy}
        aria-label={CARD_WORDS.closeOpeningOf(riskId)}
        data-testid={`close-opening-${riskId}`}
        onClick={async () => {
          const answer = await run(`/api/missions/${encodeURIComponent(missionId)}/gate`, {
            risk_id: riskId,
            resource_set_id: resourceSetId,
            gate: 'approval',
          });
          if (!answer.ok) return;
          toast({ title: `“${label}” asks you first`, description: 'From the next call.' });
          router.refresh();
        }}
      >
        {CARD_WORDS.closeOpening}
      </button>
      {error && (
        <span role="alert" className={styles.checkError}>
          {' '}
          {error}
        </span>
      )}
    </>
  );
}
