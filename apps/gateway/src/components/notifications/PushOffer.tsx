'use client';

/**
 * The home's one line (spec §4.2 bis "the interface proposes it the first time something
 * waits"): when something waits for the person and this browser could receive
 * notifications but does not, offer to subscribe it. "Not now" is remembered by this
 * browser only (`localStorage`: a convenience of one device, not a setting of the person).
 * Nothing is answered from here: the proposal subscribes a device, that is all.
 */
import { useEffect, useState } from 'react';

import { Button, Callout } from '@/components/ui';
import { proposalPutOff, putProposalOff } from '@/lib/notifications/push-client';
import { NOTIFICATION_WORDS } from '@/lib/vocabulary';

import styles from './notifications.styles';
import { usePushState, useSubscribe } from './ThisDevice';

export function PushOffer({
  publicKey,
  knownDigests,
}: {
  publicKey: string;
  knownDigests: readonly string[];
}) {
  const [state, setState] = usePushState(knownDigests);
  const [putOff, setPutOff] = useState(true);
  const { busy, error, subscribe } = useSubscribe(publicKey, setState);
  useEffect(() => setPutOff(proposalPutOff()), []);

  if (putOff || state !== 'available') return null;
  return (
    <Callout
      tone="info"
      title={NOTIFICATION_WORDS.offerTitle}
      testId="push-offer"
      action={
        <span className={styles.actions}>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            onClick={() => void subscribe()}
            data-testid="push-offer-subscribe"
          >
            {NOTIFICATION_WORDS.subscribe}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              putProposalOff();
              setPutOff(true);
            }}
            data-testid="push-offer-not-now"
          >
            {NOTIFICATION_WORDS.notNow}
          </Button>
        </span>
      }
    >
      {error ?? NOTIFICATION_WORDS.offer}
    </Callout>
  );
}
