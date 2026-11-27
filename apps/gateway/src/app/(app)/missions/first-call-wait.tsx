'use client';

/**
 * Under the key just shown (spec §7.4): the page waits for the agent's first call and
 * says what became of it, with no reload. It asks the gateway every few seconds
 * (`POST /api/missions/:id/first-call`), for ten minutes:
 *
 * - nothing yet: it waits;
 * - the key was used but no tool was called (the agent listed its tools): connected;
 * - a first call: allowed, waiting for the person's yes, or refused with the reason in
 *   one sentence. Then it stops asking.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Callout } from '@/components/ui';
import { postJson } from '@/lib/http/post-json';
import { REFUSAL_WORDS, ROUTES } from '@/lib/vocabulary';
import { isRecord } from '@vaubaan/shared/guards';

export const FIRST_CALL_POLL_MS = 3_000;
export const FIRST_CALL_WAIT_MS = 10 * 60_000;

interface FirstCall {
  readonly outcome: 'allowed' | 'refused';
  readonly tool: string | null;
  readonly refusal_code: string | null;
}

type Seen =
  | { readonly state: 'waiting' | 'connected' | 'stopped' }
  | { readonly state: 'called'; readonly first: FirstCall };

/** What an answer of the endpoint says; `null` when it is not one. */
export function seenOf(body: unknown): Seen | null {
  if (!isRecord(body)) return null;
  if (typeof body.called_at !== 'string') return { state: 'waiting' };
  const first = body.first;
  if (!isRecord(first) || (first.outcome !== 'allowed' && first.outcome !== 'refused')) {
    return { state: 'connected' };
  }
  return {
    state: 'called',
    first: {
      outcome: first.outcome,
      tool: typeof first.tool === 'string' ? first.tool : null,
      refusal_code: typeof first.refusal_code === 'string' ? first.refusal_code : null,
    },
  };
}

/** Why the gateway refused, in the interface's words; the protocol's code when it has none. */
function reasonOf(code: string | null): string {
  if (code && code in REFUSAL_WORDS) return REFUSAL_WORDS[code as keyof typeof REFUSAL_WORDS];
  return code ?? 'no reason was recorded';
}

export function FirstCallWait({ missionId }: { missionId: string }) {
  const [seen, setSeen] = useState<Seen>({ state: 'waiting' });
  const activity = `${ROUTES.missions}/${missionId}/activity`;

  useEffect(() => {
    let over = false;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > FIRST_CALL_WAIT_MS) {
        clearInterval(timer);
        setSeen((now) => (now.state === 'called' ? now : { state: 'stopped' }));
        return;
      }
      void postJson(`/api/missions/${missionId}/first-call`).then((answer) => {
        const next = answer.ok ? seenOf(answer.body) : null;
        if (over || !next || next.state === 'waiting') return;
        if (next.state === 'called') clearInterval(timer);
        setSeen(next);
      });
    }, FIRST_CALL_POLL_MS);
    return () => {
      over = true;
      clearInterval(timer);
    };
  }, [missionId]);

  if (seen.state === 'called') {
    const { first } = seen;
    const tool = first.tool ? ` (${first.tool})` : '';
    if (first.outcome === 'allowed') {
      return (
        <Callout tone="ok" title="Your agent made its first call" testId="first-call-arrived">
          The gateway allowed it{tool}. Everything it does from here is in the mission’s activity.{' '}
          <Link href={activity}>See the activity</Link>
        </Callout>
      );
    }
    if (first.refusal_code === 'approval-required') {
      return (
        <Callout
          tone="warn"
          title="Your agent’s first call waits for your yes"
          testId="first-call-asked"
        >
          The call arrived{tool} and this mission asks you first for it: nothing ran yet.{' '}
          <Link href={ROUTES.waiting}>Answer it</Link>
        </Callout>
      );
    }
    return (
      <Callout
        tone="bad"
        title="Your agent’s first call arrived, and was refused"
        testId="first-call-refused"
      >
        The gateway refused it{tool}: {reasonOf(first.refusal_code)}. Nothing ran. The mission’s
        activity says what to change. <Link href={activity}>See the activity</Link>
      </Callout>
    );
  }
  if (seen.state === 'connected') {
    return (
      <Callout tone="info" title="Your agent is connected" testId="first-call-connected">
        It reached the gateway with the key and listed its tools. Ask it anything: this line changes
        at its first call.
      </Callout>
    );
  }
  return (
    <Callout
      tone="info"
      title={seen.state === 'waiting' ? 'Waiting for your agent’s first call…' : 'No call yet'}
      testId="first-call-waiting"
    >
      {seen.state === 'waiting'
        ? 'Add the mission to your agent with the steps above, then ask it anything: this line changes when its first call arrives.'
        : 'This page stopped watching after ten minutes. The first call will show in the mission’s activity.'}
    </Callout>
  );
}
