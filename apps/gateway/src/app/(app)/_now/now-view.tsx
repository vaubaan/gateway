/**
 * The home once the person has a mission: what waits for them, answerable
 * where they see it; what is running, one line per mission; and one line of
 * counts that lead elsewhere.
 *
 * Two forms of one page (style guide §1.1). When something waits, the list of
 * what waits comes first and the missions follow. When nothing does, the page
 * is one sentence that says so and where to go; what is running is one click
 * away, and the page remembers the click.
 *
 * A yes is never given from here: the row of an approval leads to the request,
 * where the exact call and its arguments are shown (spec §3.5). A refusal runs
 * nothing and may be given at once.
 */
import Link from 'next/link';

import {
  AnswerList,
  AnswerRow,
  AvatarStack,
  Button,
  ButtonLink,
  DetailOnly,
  DetailScope,
  DetailToggle,
  Disclosure,
  EmptyState,
  Hint,
  Meter,
  PageHeader,
  RunList,
  RunRow,
  Section,
  StatusMark,
  SummaryLine,
  type StackMember,
  type SummaryItem,
} from '@/components/ui';
import { LocalDate } from '@/components/LocalDate';
import {
  ACTIONS,
  ago,
  ANSWERS,
  count,
  KEY_WORDS,
  LIMIT_WORDS,
  NOW,
  PAGES,
  REQUEST_WORDS,
  ROUTES,
  SECTIONS,
  TERMS,
  usedOf,
  WAITING,
  waitingFor,
} from '@/lib/vocabulary';
import type { NowView as View, RunningMission, StoppedMission } from '@/server/now';
import { inboxRequestPath } from '@/server/requests/url';

import { titleOf, WaitingDescription, WhoMark, whoOf } from '../waiting/parts';
import { Today } from './today';
import styles from './now.module.css';

function missionPath(id: string): string {
  return `${ROUTES.missions}/${id}`;
}

function NewMission({ primary }: { primary: boolean }) {
  return (
    <ButtonLink href={ROUTES.newMission} variant={primary ? 'primary' : 'secondary'}>
      {ACTIONS.newMission}
    </ButtonLink>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// What waits
// ─────────────────────────────────────────────────────────────────────────────

function WaitingSection({ view, viewerId, now }: { view: View; viewerId: string; now: Date }) {
  return (
    <Section
      first
      id="waiting"
      title={SECTIONS.waiting}
      count={view.waiting.length}
      note={WAITING.onlyYou}
      testId="now-waiting"
    >
      <AnswerList>
        {view.waiting.map((item, index) => {
          const { request } = item;
          const who = whoOf(item.asker, viewerId);
          const href = inboxRequestPath(request.id);
          // One primary action on the page: the oldest request.
          const variant = index === 0 ? 'primary' : 'secondary';
          return (
            <AnswerRow
              key={request.id}
              testId={`now-waiting-${request.id}`}
              who={<WhoMark who={who} />}
              title={titleOf(item)}
              age={ago(request.created_at, now)}
              description={<WaitingDescription item={item} who={who} now={now} />}
              answers={
                request.kind === 'approval' ? (
                  <>
                    <ButtonLink href={href} variant={variant}>
                      {REQUEST_WORDS.review}
                    </ButtonLink>
                    <form method="post" action={`/api/requests/${request.id}/decide`}>
                      <input type="hidden" name="resolution" value="refuse" />
                      <Button type="submit">{ANSWERS.refuse.label}</Button>
                    </form>
                  </>
                ) : (
                  <ButtonLink href={href} variant={variant}>
                    {REQUEST_WORDS.answer}
                  </ButtonLink>
                )
              }
            />
          );
        })}
      </AnswerList>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// What runs
// ─────────────────────────────────────────────────────────────────────────────

function holdersOf(mission: RunningMission): { members: StackMember[]; words: string } {
  const members = mission.holders.map((holder) => ({
    name: holder.label,
    kind: holder.kind === 'named' ? ('machine' as const) : ('person' as const),
  }));
  const words = mission.holders
    .map((holder) =>
      holder.you
        ? 'you'
        : holder.kind === 'named'
          ? `${KEY_WORDS.machineKey} ${holder.label}`
          : holder.label,
    )
    .join(', ');
  return { members, words };
}

function factsOf(mission: RunningMission, holders: string): string {
  const who = mission.issued_via
    ? NOW.preparedBy(mission.issued_via)
    : holders || KEY_WORDS.notGenerated;
  const shared = mission.creator ? [`shared by ${mission.creator}`] : [];
  return [...mission.services, who, ...shared].join(' · ');
}

/** The one figure of a row: what waits, a limit reached, or the nearest limit when it is near. */
function Figure({ mission }: { mission: RunningMission }) {
  // The creator reads what waits above this list; a teammate reads it here.
  if (mission.open_requests > 0 && mission.creator) {
    return <StatusMark tone="warn">{waitingFor(mission.creator)}</StatusMark>;
  }
  if (mission.limits_reached > 0) {
    return <StatusMark tone="bad">{LIMIT_WORDS.limitReached}</StatusMark>;
  }
  if (!mission.nearest) return null;
  return (
    <Meter
      used={mission.nearest.used}
      limit={mission.nearest.limit}
      format="percent"
      label={mission.nearest.label}
    />
  );
}

function RunningRow({ mission, now }: { mission: RunningMission; now: Date }) {
  const holders = holdersOf(mission);
  return (
    <RunRow
      testId={`now-running-${mission.id}`}
      title={mission.name}
      href={missionPath(mission.id)}
      facts={factsOf(mission, holders.words)}
      holders={holders.members.length > 0 ? <AvatarStack members={holders.members} /> : null}
      figure={<Figure mission={mission} />}
      last={
        mission.last_activity_at ? (
          <span title="The last thing recorded on this mission">
            {ago(mission.last_activity_at, now)}
          </span>
        ) : (
          NOW.noCallYet
        )
      }
      detail={
        <DetailOnly>
          <span className={styles.rowDetail}>
            {count(mission.calls_last_day, TERMS.call)} in the last 24 hours
            {mission.nearest && (
              <>
                {' '}
                · {mission.nearest.label}: {usedOf(mission.nearest.used, mission.nearest.limit)}
              </>
            )}
          </span>
        </DetailOnly>
      }
    />
  );
}

const STOPPED_WORDS: Readonly<Record<StoppedMission['state'], string>> = {
  expired: 'ended',
  revoked: 'was stopped',
  orphaned: 'lost the access behind it',
};

function NotRunning({ view }: { view: View }) {
  if (view.stopped.length === 0) return null;
  const more = view.totals.stopped - view.stopped.length;
  return (
    <Hint>
      {NOW.notRunning}:{' '}
      {view.stopped.map((mission, index) => (
        <span key={mission.id} data-testid={`now-stopped-${mission.id}`}>
          {index > 0 && ' · '}
          <Link href={missionPath(mission.id)}>{mission.name}</Link> {STOPPED_WORDS[mission.state]}
          {mission.since && mission.state !== 'orphaned' && (
            <>
              {' '}
              <LocalDate ts={mission.since} dateOnly />
            </>
          )}
        </span>
      ))}
      {more > 0 && ` · and ${more} more`}.
    </Hint>
  );
}

function RunningSection({ view, now, first }: { view: View; now: Date; first?: boolean }) {
  return (
    <DetailScope id="now:running">
      <Section
        first={first}
        id="running"
        title={SECTIONS.running}
        count={view.running.length}
        note={
          <>
            {view.running.length > 0 && <DetailToggle />}
            <Link href={ROUTES.missions}>{NOW.allMissions(view.totals.missions)}</Link>
          </>
        }
        testId="now-running"
      >
        {view.running.length === 0 ? (
          <Hint>No mission is running.</Hint>
        ) : (
          <RunList>
            {view.running.map((mission) => (
              <RunningRow key={mission.id} mission={mission} now={now} />
            ))}
          </RunList>
        )}
        <NotRunning view={view} />
      </Section>
    </DetailScope>
  );
}

function totalsOf(view: View): SummaryItem[] {
  const { totals } = view;
  const items: SummaryItem[] = [{ label: NOW.callsLastDay(totals.calls_last_day) }];
  if (totals.refused_last_hour > 0) {
    items.push({ label: NOW.refusedLastHour(totals.refused_last_hour), href: ROUTES.activity });
  }
  // Someone who works only on what was shared with them owns no account: nothing to count.
  if (totals.accounts > 0) {
    items.push({
      label: NOW.accounts(totals.accounts, totals.accounts_to_reconnect),
      href: ROUTES.accounts,
    });
  }
  return items;
}

export function NowView({ view, viewerId }: { view: View; viewerId: string }) {
  const now = new Date(view.at);
  const somethingWaits = view.waiting.length > 0;
  return (
    <>
      <PageHeader
        title={PAGES.now.title}
        lede={<Today at={view.at} />}
        primary={somethingWaits ? undefined : <NewMission primary />}
        secondary={somethingWaits ? [<NewMission key="new" primary={false} />] : undefined}
      />
      {somethingWaits ? (
        <>
          <WaitingSection view={view} viewerId={viewerId} now={now} />
          <RunningSection view={view} now={now} />
          <Section testId="now-totals">
            <SummaryLine items={totalsOf(view)} />
          </Section>
        </>
      ) : (
        <>
          <EmptyState
            testId="now-nothing"
            title={NOW.nothingNeedsYou(view.running.length)}
            links={
              <SummaryLine
                centered
                items={[
                  { label: PAGES.missions.title, href: ROUTES.missions },
                  { label: PAGES.activity.title, href: ROUTES.activity },
                  { label: PAGES.accounts.title, href: ROUTES.accounts },
                ]}
              />
            }
          />
          {view.totals.missions > 0 && (
            <div className={styles.essential}>
              <Disclosure
                id="now:essential"
                show={NOW.showRunning}
                hide={NOW.hideRunning}
                testId="now-show-running"
              >
                <RunningSection view={view} now={now} first />
                <Section testId="now-totals">
                  <SummaryLine items={totalsOf(view)} />
                </Section>
              </Disclosure>
            </div>
          )}
        </>
      )}
    </>
  );
}
