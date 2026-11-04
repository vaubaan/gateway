/**
 * `/missions` — the missions I created and the ones shared with me as a
 * teammate (spec §4.2): what each one is for, its state in words, what it
 * allows, when it ends. A mission that waits for my answer says so on its
 * row. A mission an app prepared for me through the management door names the
 * app (spec §2.4, §7.10).
 *
 * Under each mission's name, when it was created, relative ("created 2 h
 * ago", the instant in its `title`): two missions with the same name — an
 * import reissued — are told apart at a glance. Four columns by default; my
 * key is a detail, behind the page's "Show details".
 *
 * Stopped missions (stopped or expired: they serve nothing) are behind a filter,
 * like closed pull requests: "Running" by default, "Stopped" one click away, each
 * with its count (`?state=stopped`).
 */
import Link from 'next/link';

import { NeedsUser } from '@/components/auth/NeedsUser';
import { RelativeTime } from '@/components/RelativeTime';
import {
  ButtonLink,
  DataTable,
  DetailScope,
  DetailToggle,
  EmptyState,
  KeyMark,
  PageHeader,
  Section,
  Segmented,
  StatusMark,
  type Column,
} from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import {
  ACTIONS,
  capitalize,
  count,
  formatNumber,
  MISSION_LIST_FILTERS,
  expiresOn,
  KEY_WORDS,
  MISSION_WORDS,
  PAGES,
  ROUTES,
  SECTIONS,
  TERMS,
} from '@/lib/vocabulary';
import { maskedToken, type MissionOverview } from '@/server/missions';

import { missionMark, type MissionMark } from './mission-view';
import styles from './missions.module.css';

export const dynamic = 'force-dynamic';

interface ListedMission extends MissionOverview {
  readonly mark: MissionMark;
}

function columnsFor(shared: boolean, now: Date): Column<ListedMission>[] {
  return [
    {
      id: 'mission',
      header: 'Mission',
      cell: ({ mission, issued_via: issuedVia, creator }) => (
        <>
          <Link href={`${ROUTES.missions}/${mission.id}`} className={styles.name}>
            {mission.name}
          </Link>
          <span className={styles.sub}>
            {shared && `by ${creator.email ?? 'someone who left'} · `}
            <RelativeTime
              at={mission.createdAt}
              now={now}
              prefix="created"
              testId={`created-${mission.id}`}
            />
          </span>
          {issuedVia && (
            <span className={styles.sub} data-testid={`issued-via-${mission.id}`}>
              prepared by {issuedVia.client_name} for you
            </span>
          )}
        </>
      ),
    },
    {
      id: 'state',
      header: 'State',
      nowrap: true,
      cell: ({ mark }) =>
        mark.tone ? <StatusMark tone={mark.tone}>{mark.label}</StatusMark> : mark.label,
    },
    {
      id: 'allows',
      header: 'Allows',
      nowrap: true,
      cell: ({ mission }) =>
        `${count(mission.policy.length, TERMS.risk)} · ${count(mission.connections.length, TERMS.connection)}`,
    },
    {
      id: 'expires',
      header: 'Ends',
      nowrap: true,
      cell: ({ mission }) => (
        <span title={mission.expiresAt ?? undefined}>{expiresOn(mission.expiresAt, now)}</span>
      ),
    },
    {
      id: 'key',
      header: 'Your key',
      detail: true,
      nowrap: true,
      cell: ({ token, state }) =>
        // A key that works is shown masked; otherwise the cell says why there is none.
        state.kind === 'revoked' ? (
          KEY_WORDS.revoked
        ) : token ? (
          <KeyMark>{maskedToken(token.prefix)}</KeyMark>
        ) : state.kind === 'expired' ? (
          KEY_WORDS.noneMade
        ) : (
          KEY_WORDS.notGenerated
        ),
    },
  ];
}

function MissionTable({
  missions,
  shared,
  now,
  caption,
  testId,
}: {
  missions: readonly ListedMission[];
  /** Missions of other creators: the creator is named under the mission. */
  shared: boolean;
  now: Date;
  caption: string;
  testId: string;
}) {
  return (
    <DataTable
      caption={caption}
      columns={columnsFor(shared, now)}
      rows={missions}
      rowKey={({ mission }) => mission.id}
      rowTone={({ mark }) => (mark.over ? 'quiet' : (mark.tone ?? undefined))}
      testId={testId}
    />
  );
}

interface Props {
  searchParams: Promise<{ state?: string | string[] }>;
}

export default async function MissionsPage({ searchParams }: Props) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const now = new Date();
  const [missions, inbox] = await Promise.all([
    session.root.missions.service.list(session.user),
    session.root.requests.service.inbox(session.user),
  ]);
  // What waits for me, per mission: the row says it, the mission page answers it.
  const waiting = new Map<string, number>();
  for (const request of inbox) {
    waiting.set(request.mission.id, (waiting.get(request.mission.id) ?? 0) + 1);
  }
  const listed: ListedMission[] = missions.map((overview) => ({
    ...overview,
    mark: missionMark(
      overview.state,
      overview.role === 'creator' ? (waiting.get(overview.mission.id) ?? 0) : 0,
      null,
      overview.lost.length,
    ),
  }));
  const stopped = (await searchParams).state === 'stopped';
  const stoppedCount = listed.filter((m) => m.mark.over).length;
  const shown = listed.filter((m) => m.mark.over === stopped);
  const created = shown.filter((m) => m.role === 'creator');
  const shared = shown.filter((m) => m.role === 'member');
  const filter = (
    <Segmented
      label={MISSION_LIST_FILTERS.label}
      value={stopped ? 'stopped' : 'running'}
      options={[
        {
          value: 'running',
          label: `${formatNumber(listed.length - stoppedCount)} ${capitalize(MISSION_LIST_FILTERS.running)}`,
          href: ROUTES.missions,
        },
        {
          value: 'stopped',
          label: `${formatNumber(stoppedCount)} ${capitalize(MISSION_LIST_FILTERS.stopped)}`,
          href: `${ROUTES.missions}?state=stopped`,
        },
      ]}
    />
  );
  const newMission = (
    <ButtonLink href={ROUTES.newMission} variant="primary">
      {ACTIONS.newMission}
    </ButtonLink>
  );

  if (listed.length === 0) {
    return (
      <>
        <PageHeader title={PAGES.missions.title} lede={PAGES.missions.lede} />
        <EmptyState title={MISSION_WORDS.noneYet} action={newMission} testId="missions-empty">
          Create one to give an agent a key: it says which accounts the agent may touch, what it may
          do there and how much.
        </EmptyState>
      </>
    );
  }

  return (
    <DetailScope id="missions:list">
      <PageHeader title={PAGES.missions.title} lede={PAGES.missions.lede} primary={newMission} />
      <div className={styles.listFilter} data-testid="missions-filter">
        {filter}
      </div>
      <Section
        first
        title={SECTIONS.yours}
        count={created.length}
        note={<DetailToggle />}
        testId="missions-created"
      >
        {created.length === 0 ? (
          <p className={styles.quiet}>
            {stopped ? (
              MISSION_LIST_FILTERS.noneStopped
            ) : (
              <>
                {MISSION_WORDS.noneYet} <Link href={ROUTES.newMission}>Create the first one</Link>.
              </>
            )}
          </p>
        ) : (
          <MissionTable
            missions={created}
            shared={false}
            now={now}
            caption="Missions you created"
            testId="missions-created-table"
          />
        )}
      </Section>
      <Section title={SECTIONS.sharedWithYou} count={shared.length} testId="missions-shared">
        {shared.length === 0 ? (
          <p className={styles.quiet}>
            {stopped
              ? MISSION_LIST_FILTERS.noneStopped
              : `${MISSION_WORDS.noneShared} ${MISSION_WORDS.noneSharedHow}`}
          </p>
        ) : (
          <MissionTable
            missions={shared}
            shared
            now={now}
            caption="Missions shared with you"
            testId="missions-shared-table"
          />
        )}
      </Section>
    </DetailScope>
  );
}
