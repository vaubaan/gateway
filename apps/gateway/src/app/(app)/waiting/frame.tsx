/**
 * The frame of "Waiting for you", shared by the inbox (`/waiting`) and by the
 * address of one request (`/waiting/<id>`): the page header, the list of what
 * is open, and one request beside it.
 */
import { EmptyState, InboxFrame, PageHeader, SummaryLine } from '@/components/ui';
import { PAGES, REQUEST_WORDS, ROUTES } from '@/lib/vocabulary';
import type { GatewayRoot } from '@/server/compose';
import { riskExplainer } from '@/lib/providers/reference';
import type { RequestSummary, RequestView as View, WaitingItem } from '@/server/requests';
import type { UserRecord } from '@/server/store/types';
import type { SeverityWord } from '@/lib/vocabulary';
import type { RiskId } from '@vaubaan/shared';

import { answeredWords, WaitingList } from './parts';
import { RequestView } from './request-view';
import { MS_PER_DAY } from '@vaubaan/shared/time';

export interface InboxData {
  readonly items: readonly WaitingItem[];
  readonly answered: readonly RequestSummary[];
  readonly now: Date;
}

export async function loadInbox(root: GatewayRoot, user: UserRecord): Promise<InboxData> {
  const now = new Date();
  const { service } = root.requests;
  return {
    items: await service.waiting(user),
    answered: await service.answered(user, new Date(now.getTime() - MS_PER_DAY)),
    now,
  };
}

/** The severity of each permission a request is about, from the catalogs of the plugins. */
export function levelsOf(root: GatewayRoot, view: View): Record<RiskId, SeverityWord | undefined> {
  const explain = riskExplainer(root.registry);
  const levels: Record<RiskId, SeverityWord | undefined> = {};
  for (const risk of view.request.risks) levels[risk.risk_id] = explain(risk.risk_id)?.level;
  return levels;
}

function ledeOf(open: number): string {
  return open === 0 ? PAGES.waiting.lede : REQUEST_WORDS.openLede(open);
}

export function WaitingHeader({ open }: { open: number }) {
  return <PageHeader title={PAGES.waiting.title} lede={ledeOf(open)} width="wide" />;
}

/** The inbox with one request open beside the list. */
export function WaitingFrame({
  inbox,
  viewerId,
  view,
  levels,
  decided = false,
  problem = null,
}: {
  inbox: InboxData;
  viewerId: string;
  view: View;
  levels: Readonly<Record<RiskId, SeverityWord | undefined>>;
  decided?: boolean;
  problem?: string | null;
}) {
  const { items, answered, now } = inbox;
  return (
    <>
      <WaitingHeader open={items.length} />
      <InboxFrame
        list={
          <WaitingList
            items={items}
            currentId={view.request.id}
            viewerId={viewerId}
            now={now}
            footer={
              items.length === 0
                ? `${REQUEST_WORDS.nothingOpen} ${answeredWords(answered)}`
                : answeredWords(answered)
            }
          />
        }
      >
        <RequestView
          view={view}
          viewerId={viewerId}
          now={now}
          levels={levels}
          decided={decided}
          problem={problem}
        />
      </InboxFrame>
    </>
  );
}

/** Nothing is open: one sentence that says so, and where to go. */
export function NothingWaits({ inbox }: { inbox: InboxData }) {
  return (
    <>
      <WaitingHeader open={0} />
      <EmptyState
        testId="waiting-empty"
        title={REQUEST_WORDS.nothingOpen}
        links={
          <SummaryLine
            centered
            items={[
              { label: 'Now', href: ROUTES.home },
              { label: 'Missions', href: ROUTES.missions },
              { label: 'Activity', href: ROUTES.activity },
            ]}
          />
        }
      >
        When an agent needs your yes, or more room after a limit, it appears here and on Now.{' '}
        {answeredWords(inbox.answered)}
      </EmptyState>
    </>
  );
}
