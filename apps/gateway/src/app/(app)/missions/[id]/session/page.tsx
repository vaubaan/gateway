/**
 * `/missions/<id>/session` — the activity of one mission (spec §4.2, §3.3):
 * what waits for an answer, who called in the current period — per key holder
 * and per agent label —, then, one click away, what each permission used and
 * the counters of the earlier periods.
 *
 * Its events are the Activity's Timeline filtered on the mission
 * (`/activity/timeline?mission=<id>`, and `&holder=` / `&agent=` /
 * `&unlabelled=1` from the rows of who called); its audit is the Record
 * filtered on it. What a row says of an event is `eventWords`
 * (`event-words.ts`).
 *
 * A key holder is authenticated: it is whose key the call presented (spec
 * §8). An agent label is what a caller said about itself (spec §0, §7.9): the
 * page says so where it lists them. Both tables count calls; neither is a
 * limit: a mission has one set of limits, however many keys or agents.
 *
 * The creator and the teammates of the mission read this page (spec §11.2
 * "What a member sees"); only the creator is given the links that answer.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { lineKeyOf } from '@vaubaan/shared/domain';

import { LocalDate } from '@/components/LocalDate';
import { NeedsUser } from '@/components/auth/NeedsUser';
import {
  AgentLabel,
  AnswerList,
  AnswerRow,
  Avatar,
  ButtonLink,
  DataTable,
  Disclosure,
  Hint,
  KeyHolder,
  Mono,
  PageHeader,
  Section,
  StatusMark,
  type Column,
} from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import {
  DOC_PAGES,
  agoSentence,
  count,
  KEY_WORDS,
  limitsResetEvery,
  periodWord,
  ROUTES,
  SECTIONS,
  TERMS,
  usage,
  waitingFor,
} from '@/lib/vocabulary';
import {
  AUDIT_PARAMS,
  holderParam,
  TIMELINE_PARAMS,
  type MissionSessionView,
  type SessionHolderView,
} from '@/server/audit';
import { riskExplainer } from '@/lib/providers/reference';

import styles from '../../missions.module.css';
import { missionMark } from '../../mission-view';
import { PermissionsUsage } from '../permissions-usage';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

type HolderActivity = MissionSessionView['holder_activity'][number];
type LabelActivity = MissionSessionView['label_activity'][number];
type PeriodRow = MissionSessionView['periods'][number];

/** A person by their email, a machine key by its name; `null`: not attributed. */
function HolderName({ holder }: { holder: SessionHolderView | null }) {
  if (!holder) return <span className={styles.quietText}>not attributed (an earlier version)</span>;
  return (
    <KeyHolder
      name={holder.label}
      kind={holder.kind === 'member' ? 'person' : 'machine'}
      qualifier={holder.kind === 'named' ? `· ${KEY_WORDS.machineKey}` : undefined}
    />
  );
}

export default async function MissionSessionPage({ params }: Props) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { id } = await params;
  const { root, user } = session;
  const [view, detail] = await Promise.all([
    root.audit.sessions.get(user, id),
    root.missions.service.get(user, id),
  ]);
  if (!view || !detail) notFound();
  const { mission, state } = view;
  const now = new Date();
  const base = `${ROUTES.missions}/${encodeURIComponent(mission.id)}`;
  const ofMission = encodeURIComponent(mission.id);
  const timelineOfMission = `${ROUTES.activityTimeline}?${TIMELINE_PARAMS.mission}=${ofMission}`;
  const recordOfMission = `${ROUTES.activityRecord}?${AUDIT_PARAMS.mission}=${ofMission}`;
  const isCreator = view.viewer_role === 'creator';
  const creatorName = isCreator ? null : (detail.creator.email ?? 'the creator');
  const mark = missionMark(state, view.open_requests.length, creatorName);
  const periodSeconds = detail.period.kind === 'recurring' ? detail.period.length_seconds : null;
  const period = periodWord(periodSeconds);
  const labels = new Map(view.risks.map((risk) => [risk.risk_id, risk.label]));
  /** The rows of one holder or one label, in the Timeline and in the Record of the mission. */
  const showLinks = (timelineParam: string, recordParam: string | null) => (
    <span className={styles.rowLinks}>
      <Link href={`${timelineOfMission}&${timelineParam}`}>in the timeline</Link>
      {recordParam && <Link href={`${recordOfMission}&${recordParam}`}>in the full record</Link>}
    </span>
  );

  const holderColumns: Column<HolderActivity>[] = [
    { id: 'holder', header: 'Who', cell: (a) => <HolderName holder={a.holder} /> },
    { id: 'allowed', header: 'Allowed', align: 'right', cell: (a) => a.allowed },
    { id: 'refused', header: 'Refused', align: 'right', cell: (a) => a.refused },
    {
      id: 'last',
      header: 'Last call',
      nowrap: true,
      cell: (a) => <span title={a.last_seen_at}>{agoSentence(a.last_seen_at, now)}</span>,
    },
    {
      id: 'show',
      header: 'Show',
      cell: (a) =>
        a.holder
          ? showLinks(
              `${TIMELINE_PARAMS.holder}=${encodeURIComponent(holderParam(a.holder))}`,
              `${AUDIT_PARAMS.holder}=${encodeURIComponent(holderParam(a.holder))}`,
            )
          : '—',
    },
  ];
  const labelColumns: Column<LabelActivity>[] = [
    {
      id: 'label',
      header: 'Agent',
      cell: (a) =>
        a.label === null ? (
          <span className={styles.quietText}>no label</span>
        ) : (
          <AgentLabel>{a.label}</AgentLabel>
        ),
    },
    { id: 'allowed', header: 'Allowed', align: 'right', cell: (a) => a.allowed },
    { id: 'refused', header: 'Refused', align: 'right', cell: (a) => a.refused },
    {
      id: 'last',
      header: 'Last call',
      nowrap: true,
      cell: (a) => <span title={a.last_seen_at}>{agoSentence(a.last_seen_at, now)}</span>,
    },
    {
      id: 'show',
      header: 'Show',
      cell: (a) =>
        a.label === null
          ? showLinks(`${TIMELINE_PARAMS.unlabelled}=1`, null)
          : showLinks(
              `${TIMELINE_PARAMS.agent}=${encodeURIComponent(a.label)}`,
              `${AUDIT_PARAMS.agent}=${encodeURIComponent(a.label)}`,
            ),
    },
  ];
  const periodColumns: Column<PeriodRow>[] = [
    {
      id: 'period',
      header: 'Period',
      nowrap: true,
      cell: (row) => (
        <>
          <LocalDate ts={row.start} />
          {row.end ? (
            <>
              {' → '}
              <LocalDate ts={row.end} />
            </>
          ) : (
            ' → no reset'
          )}
          {row.current && <span className={styles.quietText}> · current</span>}
        </>
      ),
    },
    {
      id: 'counted',
      header: 'Counted',
      cell: (row) => {
        const counted = view.risks.filter((risk) => (row.consumed[lineKeyOf(risk)] ?? 0) > 0);
        if (counted.length === 0) return <span className={styles.quietText}>nothing</span>;
        return counted.map((risk) => (
          <span key={risk.risk_id} className={styles.permissionLine}>
            {risk.label} · {usage(row.consumed[lineKeyOf(risk)] ?? 0, risk.quota)}
            <span className={styles.sub}>
              <Mono quiet>{risk.risk_id}</Mono>
            </span>
          </span>
        ));
      },
    },
  ];

  const noPeriod = (
    <p className={styles.quiet}>No current period: the mission is {mark.label.toLowerCase()}.</p>
  );
  const noCall = <p className={styles.quiet}>No call {period} yet.</p>;

  return (
    <>
      <PageHeader
        doc={DOC_PAGES.missionActivity}
        width="wide"
        crumbs={[
          { label: 'Missions', href: ROUTES.missions },
          { label: mission.name, href: base },
          { label: 'Activity' },
        ]}
        title={`Activity of ${mission.name}`}
        status={
          mark.tone || mark.over ? (
            <StatusMark tone={mark.tone ?? 'neutral'} testId="mission-state">
              {mark.label}
            </StatusMark>
          ) : undefined
        }
        lede={
          <span data-testid="timeline-retention">
            Every call made with a key of this mission and every change to it, kept{' '}
            {root.config.retentionDays} days.
          </span>
        }
        secondary={[
          <ButtonLink key="timeline" href={timelineOfMission}>
            Timeline
          </ButtonLink>,
          <ButtonLink key="record" href={recordOfMission}>
            Full record
          </ButtonLink>,
        ]}
      />

      {view.open_requests.length > 0 && (
        <Section
          first
          title={isCreator ? SECTIONS.waiting : `Waiting for ${creatorName}`}
          count={view.open_requests.length}
          testId="open-requests"
        >
          {!isCreator && (
            <p className={styles.quiet} data-testid="requests-are-the-creators">
              What the agents of this mission ask is answered by its creator alone. You see that it
              waits; you cannot answer it.
            </p>
          )}
          <AnswerList label="Requests of this mission">
            {view.open_requests.map((request) => (
              <AnswerRow
                key={request.id}
                who={<Avatar name="agent" kind="machine" size="md" />}
                title={
                  <>
                    {labels.get(request.risk_id) ?? request.risk_id} ·{' '}
                    {request.kind === 'claim' ? 'asks for more room' : waitingFor(creatorName)}
                  </>
                }
                description={
                  <>
                    <Mono quiet>{request.risk_id}</Mono> · asked{' '}
                    {agoSentence(request.created_at, now)} · expires{' '}
                    <LocalDate ts={request.expires_at} />
                  </>
                }
                answers={
                  request.path ? (
                    <ButtonLink href={request.path} variant="primary" data-request={request.kind}>
                      Review and answer
                    </ButtonLink>
                  ) : undefined
                }
              />
            ))}
          </AnswerList>
        </Section>
      )}

      <Section
        first={view.open_requests.length === 0}
        title={`Who called ${period}`}
        note="Whose key each call presented. Counts, not limits: every key draws on the same limits."
        testId="holder-activity"
      >
        {state.kind !== 'active' ? (
          noPeriod
        ) : (
          <DataTable
            caption={`Calls ${period} per key holder`}
            columns={holderColumns}
            rows={view.holder_activity}
            rowKey={(a) => (a.holder ? holderParam(a.holder) : 'unattributed')}
            empty={noCall}
          />
        )}
      </Section>

      <Section
        title={`Agents ${period}`}
        note="A label is what a caller said about itself: not verified, and it decides nothing."
        testId="label-activity"
      >
        {state.kind !== 'active' ? (
          noPeriod
        ) : (
          <DataTable
            caption={`Calls ${period} per agent label`}
            columns={labelColumns}
            rows={view.label_activity}
            rowKey={(a) => a.label ?? 'unlabelled'}
            empty={noCall}
          />
        )}
        {view.agent_labels.length > 0 && (
          <Hint>
            Seen since the record began:{' '}
            {view.agent_labels.map((seen, index) => (
              <span key={seen.label} data-testid="label-seen">
                {index > 0 && ', '}
                <AgentLabel>{seen.label}</AgentLabel> {count(seen.calls, TERMS.call)}
              </span>
            ))}
            .
          </Hint>
        )}
      </Section>

      <Section
        title={SECTIONS.permissionsAndUsage}
        count={view.risks.length}
        note={`${limitsResetEvery(periodSeconds)}; a limit you raised or reset shows in the timeline.`}
        testId="session-permissions"
      >
        <Disclosure
          id={`mission:${mission.id}:session-permissions`}
          show={`All ${count(view.risks.length, TERMS.risk)}, with what was used`}
          hide="Hide the permissions"
        >
          <PermissionsUsage
            detail={detail}
            explain={riskExplainer(root.registry)}
            periodSeconds={periodSeconds}
            editable={false}
          />
        </Disclosure>
      </Section>

      <Section title="Earlier periods" count={view.periods.length} testId="session-periods">
        <Disclosure
          id={`mission:${mission.id}:session-periods`}
          show="Show what each period counted"
          hide="Hide the periods"
        >
          <DataTable
            caption="What was counted, per period"
            columns={periodColumns}
            rows={view.periods}
            rowKey={(row) => row.start}
            empty={<p className={styles.quiet}>Nothing counted yet.</p>}
          />
        </Disclosure>
      </Section>
    </>
  );
}
