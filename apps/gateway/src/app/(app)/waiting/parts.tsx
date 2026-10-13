/**
 * What "Waiting for you" says of one request, shared by the home (a row with
 * its answers) and the inbox (an item of the list): who asks, what, on which
 * mission, what is left. Server components and pure helpers; the sentences are
 * the vocabulary's.
 */
import { Avatar, InboxItem, InboxList, Mono } from '@/components/ui';
import {
  agoPhrase,
  asker,
  ASKED_FIRST,
  limitReachedOn,
  missionReachedLimit,
  periodNow,
  REQUEST_WORDS,
  roomLeft,
  until,
  usedOf,
} from '@/lib/vocabulary';
import type { RequestAsker, RequestSummary, WaitingItem } from '@/server/requests';
import { inboxRequestPath } from '@/server/requests/url';

/** Who asks, as a page names them. */
export interface Who {
  /** What the mark is drawn from: the holder's name, else the agent's label, else "agent". */
  readonly name: string;
  readonly machine: boolean;
  readonly you: boolean;
  /** "Carol · codex", "You · codex", "machine key nightly", "An agent". */
  readonly words: string;
  readonly holder: string | null;
  readonly agent: string | null;
}

export function whoOf(asked: RequestAsker | null, viewerId: string): Who {
  const machine = asked?.token_kind === 'named';
  const you = asked?.user_id === viewerId;
  const holder = asked?.holder ?? null;
  const agent = asked?.agent_label ?? null;
  return {
    name: holder ?? agent ?? 'agent',
    machine,
    you,
    holder,
    agent,
    words: asker({ holder, machine, you, agent }),
  };
}

export function WhoMark({ who, size = 'md' }: { who: Who; size?: 'xs' | 'sm' | 'md' }) {
  return <Avatar name={who.name} kind={who.machine ? 'machine' : 'person'} size={size} />;
}

/** The permissions a request is about, in words: "Merge to a protected branch", "A and 1 more". */
export function permissionsOf(request: RequestSummary): string {
  const [first, ...others] = request.risks.map((risk) => risk.label);
  if (first === undefined) return request.risk_label;
  if (others.length === 0) return first;
  return `${first} and ${others.length} more`;
}

/** The statement of a row: what is asked (an approval), or that a limit was reached. */
export function titleOf(item: WaitingItem): string {
  return item.request.kind === 'approval'
    ? permissionsOf(item.request)
    : missionReachedLimit(item.request.mission.name, item.period_seconds);
}

/** The shorter statement of an inbox item. */
export function shortTitleOf(item: WaitingItem): string {
  return item.request.kind === 'approval'
    ? permissionsOf(item.request)
    : limitReachedOn(item.request.risk_label, item.period_seconds);
}

/** "resets in 13 h"; `null` for a mission whose limits never reset. */
export function resetWords(periodEnd: string | null, now: Date): string | null {
  return periodEnd ? `resets ${until(periodEnd, now)}` : null;
}

/**
 * The line under the statement, on the home: who and where, why it is asked,
 * the room left. A tool is printed as the protocol spells it.
 */
export function WaitingDescription({ item, who, now }: { item: WaitingItem; who: Who; now: Date }) {
  const { request, budget, period, period_seconds: periodSeconds } = item;
  const [line] = budget;
  if (request.kind === 'approval') {
    return (
      <>
        {who.words} on {request.mission.name}
        {request.tool && (
          <>
            {' '}
            · <Mono>{request.tool}</Mono>
          </>
        )}{' '}
        · {ASKED_FIRST}
        {line && <> · {roomLeft(line.remaining, line.quota, periodNow(periodSeconds))}</>}
      </>
    );
  }
  const reset = resetWords(period.end, now);
  return (
    <>
      {request.risk_label}
      {line && <> · {usedOf(line.consumed, line.quota)}</>} · {who.words} is stopped on it until{' '}
      {reset ? `the limit ${reset} or your answer` : 'your answer'}
    </>
  );
}

/** The list of the inbox: one item per open request, the one beside it marked. */
export function WaitingList({
  items,
  currentId,
  viewerId,
  now,
  footer,
}: {
  items: readonly WaitingItem[];
  currentId: string | null;
  viewerId: string;
  now: Date;
  footer?: React.ReactNode;
}) {
  return (
    <InboxList label="Open requests" footer={footer} testId="waiting-list">
      {items.map((item) => {
        const who = whoOf(item.asker, viewerId);
        const { request } = item;
        const reset = resetWords(item.period.end, now);
        return (
          <InboxItem
            key={request.id}
            href={inboxRequestPath(request.id)}
            current={request.id === currentId}
            who={<WhoMark who={who} size="sm" />}
            title={shortTitleOf(item)}
            context={
              <>
                {request.mission.name} · {who.words}
              </>
            }
            meta={
              request.kind === 'approval'
                ? `${agoPhrase(request.created_at, now)} · expires ${until(request.expires_at, now)}`
                : `${agoPhrase(request.created_at, now)}${reset ? ` · ${reset} anyway` : ''}`
            }
            testId={`waiting-item-${request.id}`}
          />
        );
      })}
    </InboxList>
  );
}

/** "In the last 24 hours: 3 approved, 1 refused." */
export function answeredWords(answered: readonly RequestSummary[]): string {
  const by = (state: RequestSummary['state']): number =>
    answered.filter((request) => request.state === state).length;
  return REQUEST_WORDS.answeredLastDay(by('granted'), by('refused'), by('expired'));
}
