'use client';

/**
 * "checked 12 min ago · ↻ Check now" on a card with future resources (ADR
 * resource-set-is-one-environment-with-optional-future-resources): when discovery last
 * ran on the account, and running it now (`POST /api/missions/:id/resources/check`),
 * after which the page reads the cards again — what joined is on them, and in the
 * mission's activity.
 */
import { useRouter } from 'next/navigation';

import { agoSentence, CARD_WORDS } from '@/lib/vocabulary';
import { useAction } from '@/lib/http/post-json';

import styles from '../cards/cards.styles';

export function CheckNow({
  missionId,
  accountId,
  lastCheckedAt,
  now,
  canCheck,
}: {
  missionId: string;
  accountId: string;
  lastCheckedAt: string | null;
  /** The instant the page was rendered at, so that "12 min ago" reads the same on both sides. */
  now: string;
  /** The creator (or an owner of the account) may run it. */
  canCheck: boolean;
}) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const when =
    lastCheckedAt === null
      ? CARD_WORDS.neverChecked
      : CARD_WORDS.checked(agoSentence(lastCheckedAt, new Date(now)));
  return (
    <span className={styles.checked} data-testid="future-check">
      {when}
      {canCheck && (
        <>
          {' · '}
          <button
            type="button"
            className={styles.checkNow}
            disabled={busy}
            onClick={async () => {
              const answer = await run(
                `/api/missions/${encodeURIComponent(missionId)}/resources/check`,
                { account_id: accountId },
              );
              if (answer.ok) router.refresh();
            }}
          >
            {CARD_WORDS.checkNow}
          </button>
        </>
      )}
      {error && (
        <span role="alert" className={styles.checkError}>
          {' '}
          {error}
        </span>
      )}
    </span>
  );
}
