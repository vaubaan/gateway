'use client';

/**
 * Under the key just shown (spec §7.4): the page waits for the agent's first call and
 * says when it arrived, with no reload. It asks the gateway every few seconds when the
 * person's own key was last used (`POST /api/missions/:id/first-call`), for ten minutes;
 * after that it says where the call will show. A first call the gateway refused used
 * the key too: the mission's activity says what was allowed and what was refused, and why.
 */
import { useEffect, useState } from 'react';

import Link from 'next/link';

import { Callout } from '@/components/ui';
import { postJson } from '@/lib/http/post-json';
import { ROUTES } from '@/lib/vocabulary';

export const FIRST_CALL_POLL_MS = 3_000;
export const FIRST_CALL_WAIT_MS = 10 * 60_000;

function calledAtOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('called_at' in body)) return null;
  return typeof body.called_at === 'string' ? body.called_at : null;
}

export function FirstCallWait({ missionId }: { missionId: string }) {
  const [state, setState] = useState<'waiting' | 'called' | 'stopped'>('waiting');
  const activity = `${ROUTES.missions}/${missionId}/activity`;

  useEffect(() => {
    let over = false;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > FIRST_CALL_WAIT_MS) {
        clearInterval(timer);
        setState('stopped');
        return;
      }
      void postJson(`/api/missions/${missionId}/first-call`).then((answer) => {
        if (over || !answer.ok || calledAtOf(answer.body) === null) return;
        clearInterval(timer);
        setState('called');
      });
    }, FIRST_CALL_POLL_MS);
    return () => {
      over = true;
      clearInterval(timer);
    };
  }, [missionId]);

  if (state === 'called') {
    return (
      <Callout tone="ok" title="Your agent made its first call" testId="first-call-arrived">
        The key works and the gateway answered. What it allowed, and what it refused and why, is in
        the mission’s activity. <Link href={activity}>See the activity</Link>
      </Callout>
    );
  }
  return (
    <Callout
      tone="info"
      title={state === 'waiting' ? 'Waiting for your agent’s first call…' : 'No call yet'}
      testId="first-call-waiting"
    >
      {state === 'waiting'
        ? 'Add the mission to your agent with the steps above, then ask it anything: this line changes when its first call arrives.'
        : 'This page stopped watching after ten minutes. The first call will show in the mission’s activity.'}
    </Callout>
  );
}
