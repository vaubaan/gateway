'use client';

/**
 * "This device" on Settings → Notifications (spec §4.2 bis): what this browser can do and,
 * when it can, the person's act that subscribes it. On an iPhone or iPad not opened from
 * the Home Screen it says how to install the interface and offers nothing else; a browser
 * without push is said so in one sentence.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button, Callout, Hint, useToast } from '@/components/ui';
import {
  readPushState,
  subscribeThisDevice,
  type PushState,
} from '@/lib/notifications/push-client';
import { NOTIFICATION_WORDS } from '@/lib/vocabulary';

/**
 * What this browser can do, read once mounted (the server cannot know), against the digests
 * of the person's live devices (the server's word on what it delivers to).
 */
export function usePushState(
  knownDigests: readonly string[],
): readonly [PushState | null, (state: PushState) => void] {
  const [state, setState] = useState<PushState | null>(null);
  const known = knownDigests.join(',');
  useEffect(() => {
    let live = true;
    void readPushState(known === '' ? [] : known.split(',')).then((read) => {
      if (live) setState(read);
    });
    return () => {
      live = false;
    };
  }, [known]);
  return [state, setState];
}

/** The click that subscribes; shared by the Settings page and the home's proposal. */
export function useSubscribe(publicKey: string | null, onDone: (state: PushState) => void) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function subscribe() {
    if (publicKey === null) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await subscribeThisDevice(publicKey);
      if (outcome.ok) {
        onDone('subscribed');
        toast({ title: NOTIFICATION_WORDS.added });
        router.refresh();
      } else if (outcome.reason === 'denied') {
        onDone('denied');
      } else {
        setError(outcome.message);
      }
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, subscribe };
}

export function ThisDevice({
  publicKey,
  knownDigests,
}: {
  publicKey: string | null;
  /** The endpoint digests of the person's live devices (`liveEndpointDigests`). */
  knownDigests: readonly string[];
}) {
  const [state, setState] = usePushState(knownDigests);
  const { busy, error, subscribe } = useSubscribe(publicKey, setState);

  if (state === null) return null;
  if (state === 'install-first') {
    return (
      <Callout tone="info" testId="push-install-first">
        {NOTIFICATION_WORDS.installFirst}
      </Callout>
    );
  }
  if (state === 'unsupported' || publicKey === null) {
    return <Hint>{NOTIFICATION_WORDS.unsupported}</Hint>;
  }
  if (state === 'denied') {
    return (
      <Callout tone="warn" testId="push-denied">
        {NOTIFICATION_WORDS.denied}
      </Callout>
    );
  }
  if (state === 'subscribed') {
    return (
      <Callout tone="ok" testId="push-subscribed">
        {NOTIFICATION_WORDS.subscribed}
      </Callout>
    );
  }
  return (
    <div data-testid="push-available">
      <Button
        variant="primary"
        onClick={() => void subscribe()}
        loading={busy}
        data-testid="push-subscribe"
      >
        {NOTIFICATION_WORDS.subscribe}
      </Button>
      {error && (
        <Callout tone="bad" testId="push-error">
          {error}
        </Callout>
      )}
    </div>
  );
}
