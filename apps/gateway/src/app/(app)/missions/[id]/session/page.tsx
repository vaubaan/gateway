/**
 * `/missions/<id>/session` — the mission's session (spec §4.2, §3.3): counters
 * per risk and per period with what is left, gate per risk, open requests (by
 * link), the calls of the current period per agent label, and the event
 * timeline — whole, or the calls of one label (`?agent=<label>`,
 * `?unlabelled=1`).
 *
 * An agent label is what a caller declared about itself (spec §0, §7.9): the
 * page says so wherever it shows one. The per-label counts are counts of
 * calls, not a budget.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LocalDate } from '@/components/LocalDate';
import { NeedsUser } from '@/components/auth/NeedsUser';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Stack,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import {
  ALL_EVENTS,
  AUDIT_PARAMS,
  decodeCursor,
  encodeCursor,
  type MissionSessionView,
  type SessionEventView,
  type SessionTimelineFilter,
} from '@/server/audit';

import styles from '../../../audit/audit.module.css';
import { StateBadge } from '../../state-badge';

export const dynamic = 'force-dynamic';

const EVENTS_CURSOR_PARAM = 'before';
/** Timeline filter: the calls of one agent label. */
const AGENT_PARAM = 'agent';
/** Timeline filter: the calls that carried no label. */
const UNLABELLED_PARAM = 'unlabelled';
const MAX_LABEL_PARAM_LENGTH = 200;

type SearchParams = Record<string, string | string[] | undefined>;

function timelineFilterOf(params: SearchParams): SessionTimelineFilter {
  const agent = params[AGENT_PARAM];
  if (typeof agent === 'string') {
    const label = agent.trim();
    if (label.length > 0 && label.length <= MAX_LABEL_PARAM_LENGTH) return { kind: 'label', label };
  }
  return params[UNLABELLED_PARAM] === '1' ? { kind: 'unlabelled' } : ALL_EVENTS;
}

/** The session page's own query string for a timeline filter and a position. */
function sessionQuery(filter: SessionTimelineFilter, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filter.kind === 'label') params.set(AGENT_PARAM, filter.label);
  if (filter.kind === 'unlabelled') params.set(UNLABELLED_PARAM, '1');
  if (cursor) params.set(EVENTS_CURSOR_PARAM, cursor);
  const text = params.toString();
  return text ? `?${text}` : '';
}

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}

export default async function MissionSessionPage({ params, searchParams }: Props) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { id } = await params;
  const query = await searchParams;
  const cursorRaw = query[EVENTS_CURSOR_PARAM];
  const cursor = typeof cursorRaw === 'string' ? decodeCursor(cursorRaw) : null;
  const filter = timelineFilterOf(query);
  const view = await session.root.audit.sessions.get(session.user, id, {
    eventsBefore: cursor,
    timeline: filter,
  });
  if (!view) notFound();
  const { mission, state } = view;
  const base = `/missions/${encodeURIComponent(mission.id)}`;
  const sessionPath = `${base}/session`;
  const auditOfMission = `/audit?${AUDIT_PARAMS.mission}=${encodeURIComponent(mission.id)}`;

  return (
    <Stack gap="var(--space-5)">
      <div className={styles.pageHead}>
        <div>
          <p className={styles.muted}>
            <Link href="/missions">Missions</Link> / <Link href={base}>{mission.name}</Link> /
          </p>
          <h1>
            Session <StateBadge state={state} />
          </h1>
        </div>
        <Link href={auditOfMission}>Audit of this mission</Link>
      </div>

      <Card>
        <CardBody>
          <dl className={styles.facts}>
            <dt>Session</dt>
            <dd>
              {view.session ? (
                <>
                  opened by the first call, <LocalDate ts={view.session.created_at} />
                </>
              ) : (
                'not opened yet: no call was made with this mission'
              )}
            </dd>
            <dt>Current period</dt>
            <dd>
              <PeriodLine state={state} />
            </dd>
            <dt>Agent labels seen</dt>
            <dd>
              {view.agent_labels.length === 0 ? (
                'none'
              ) : (
                <div className={styles.labels}>
                  {view.agent_labels.map((seen) => (
                    <span key={seen.label}>
                      <Badge mono>{seen.label}</Badge> {seen.calls}{' '}
                      {seen.calls === 1 ? 'call' : 'calls'}, last <LocalDate ts={seen.lastSeenAt} />
                    </span>
                  ))}
                </div>
              )}
            </dd>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Budget this period — per risk</CardTitle>
        </CardHeader>
        <CardBody>
          <p className={styles.muted}>
            “Counted” is the counter as it stands: a claim you granted (period reset, actions given
            back) lowers it, and shows in the timeline.
          </p>
        </CardBody>
        <Table>
          <Thead>
            <Tr>
              <Th>Risk</Th>
              <Th>Quota</Th>
              <Th>Counted</Th>
              <Th>Left</Th>
              <Th>Rate limit</Th>
              <Th>Gate</Th>
            </Tr>
          </Thead>
          <Tbody>
            {view.risks.map((risk) => (
              <Tr key={risk.risk_id}>
                <Td>
                  {risk.label}
                  <div className={styles.mono}>{risk.risk_id}</div>
                </Td>
                <Td>{risk.quota}</Td>
                <Td>{risk.consumed ?? '—'}</Td>
                <Td>
                  {risk.remaining ?? '—'}{' '}
                  {risk.exhausted && <Badge tone="warning">exhausted</Badge>}
                </Td>
                <Td>
                  {risk.rate_limit.max} per {risk.rate_limit.window_seconds}s
                </Td>
                <Td>
                  {risk.gate === 'approval' ? <Badge tone="warning">approval</Badge> : 'auto'}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Counters per period</CardTitle>
        </CardHeader>
        {view.periods.length === 0 ? (
          <div className={styles.empty}>Nothing counted yet.</div>
        ) : (
          <div className={styles.scroll}>
            <Table>
              <Thead>
                <Tr>
                  <Th>Period</Th>
                  {view.risks.map((risk) => (
                    <Th key={risk.risk_id} className={`${styles.mono} ${styles.nowrap}`}>
                      {risk.risk_id}
                    </Th>
                  ))}
                </Tr>
              </Thead>
              <Tbody>
                {view.periods.map((period) => (
                  <Tr key={period.start}>
                    <Td className={styles.nowrap}>
                      <LocalDate ts={period.start} />
                      {period.end ? (
                        <>
                          {' → '}
                          <LocalDate ts={period.end} />
                        </>
                      ) : (
                        ' → no reload'
                      )}{' '}
                      {period.current && <Badge tone="info">current</Badge>}
                    </Td>
                    {view.risks.map((risk) => (
                      <Td key={risk.risk_id}>
                        {period.consumed[risk.risk_id] ?? 0} / {risk.quota}
                      </Td>
                    ))}
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Open requests</CardTitle>
        </CardHeader>
        {view.open_requests.length === 0 ? (
          <div className={styles.empty}>No request is waiting for you on this mission.</div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Request</Th>
                <Th>Risk</Th>
                <Th>Opened</Th>
                <Th>Expires</Th>
              </Tr>
            </Thead>
            <Tbody>
              {view.open_requests.map((request) => (
                <Tr key={request.id}>
                  <Td>
                    <Link href={request.path}>
                      {request.kind === 'claim' ? 'Claim' : 'Approval request'}
                    </Link>
                  </Td>
                  <Td className={styles.mono}>{request.risk_id}</Td>
                  <Td>
                    <LocalDate ts={request.created_at} />
                  </Td>
                  <Td>
                    <LocalDate ts={request.expires_at} />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      <Card data-testid="label-activity">
        <CardHeader>
          <CardTitle>Calls per agent label — current period</CardTitle>
        </CardHeader>
        <CardBody>
          <p className={styles.muted}>
            For information only: this is not a budget. A label is what a caller said about itself;
            the gateway does not verify it and decides nothing on it. Every agent of the mission
            draws from the same budget per risk, above.
          </p>
        </CardBody>
        {state.kind !== 'active' ? (
          <div className={styles.empty}>No current period: the mission is {state.kind}.</div>
        ) : view.label_activity.length === 0 ? (
          <div className={styles.empty}>No call in this period yet.</div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Agent label</Th>
                <Th>Calls allowed</Th>
                <Th>Calls refused</Th>
                <Th>Last call</Th>
                <Th>Show</Th>
              </Tr>
            </Thead>
            <Tbody>
              {view.label_activity.map((activity) => {
                const own: SessionTimelineFilter =
                  activity.label === null
                    ? { kind: 'unlabelled' }
                    : { kind: 'label', label: activity.label };
                return (
                  <Tr key={activity.label ?? ''} data-label={activity.label ?? ''}>
                    <Td>
                      {activity.label === null ? (
                        <span className={styles.muted}>no label</span>
                      ) : (
                        <Badge mono>{activity.label}</Badge>
                      )}
                    </Td>
                    <Td>{activity.allowed}</Td>
                    <Td>{activity.refused}</Td>
                    <Td>
                      <LocalDate ts={activity.last_seen_at} />
                    </Td>
                    <Td className={styles.nowrap}>
                      <Link href={`${sessionPath}${sessionQuery(own, null)}`}>in the timeline</Link>
                      {activity.label !== null && (
                        <>
                          {' · '}
                          <Link
                            href={`${auditOfMission}&${AUDIT_PARAMS.agent}=${encodeURIComponent(activity.label)}`}
                          >
                            in the audit
                          </Link>
                        </>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </Card>

      <Card data-testid="timeline">
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        {filter.kind !== 'all' && (
          <CardBody>
            <p className={styles.muted} data-testid="timeline-filter">
              {filter.kind === 'label' ? (
                <>
                  Calls labelled <Badge mono>{filter.label}</Badge> only
                </>
              ) : (
                'Calls without an agent label only'
              )}
              ; requests, resets and other events carry no label and are not listed.{' '}
              <Link href={sessionPath}>Show the whole timeline</Link>
            </p>
          </CardBody>
        )}
        {view.events.length === 0 ? (
          <div className={styles.empty}>
            {filter.kind === 'all' ? 'No event yet.' : 'No call matches on this page.'}
          </div>
        ) : (
          <div className={styles.scroll}>
            <Table>
              <Thead>
                <Tr>
                  <Th>When</Th>
                  <Th>Event</Th>
                  <Th>Tool</Th>
                  <Th>Risks → left</Th>
                  <Th>Agent / actor</Th>
                  <Th>Detail</Th>
                </Tr>
              </Thead>
              <Tbody>
                {view.events.map((event) => (
                  <EventRow key={event.id} event={event} openRequests={view.open_requests} />
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>

      <div className={styles.pager}>
        <span>
          {view.events.length} {view.events.length === 1 ? 'event' : 'events'}, newest first
          {view.events_scan_limited && ' — older events were not searched yet: follow “Older”'}
        </span>
        <span>
          {cursor && <Link href={`${sessionPath}${sessionQuery(filter, null)}`}>Newest</Link>}
          {cursor && view.next_events && ' · '}
          {view.next_events && (
            <Link href={`${sessionPath}${sessionQuery(filter, encodeCursor(view.next_events))}`}>
              Older
            </Link>
          )}
        </span>
      </div>
    </Stack>
  );
}

function PeriodLine({ state }: { state: MissionSessionView['state'] }) {
  if (state.kind !== 'active') return <>none: the mission is {state.kind}</>;
  return (
    <>
      since <LocalDate ts={state.period.start} />
      {state.period.end ? (
        <>
          , reloads <LocalDate ts={state.period.end} />
        </>
      ) : (
        ', never reloads (one-off mission)'
      )}
    </>
  );
}

const EVENT_TONE: Record<string, 'success' | 'danger' | 'warning' | 'info' | 'neutral'> = {
  'call-allowed': 'success',
  'call-refused': 'danger',
  request: 'warning',
  reset: 'info',
  extension: 'info',
  revocation: 'danger',
};

function EventRow({
  event,
  openRequests,
}: {
  event: SessionEventView;
  openRequests: MissionSessionView['open_requests'];
}) {
  const request = openRequests.find((r) => r.id === event.request_id);
  return (
    <Tr>
      <Td className={styles.nowrap}>
        <LocalDate ts={event.ts} />
      </Td>
      <Td>
        <Badge tone={EVENT_TONE[event.kind] ?? 'neutral'}>{event.kind}</Badge>
        {event.refusal_code && (
          <div className={`${styles.mono} ${styles.nowrap}`}>{event.refusal_code}</div>
        )}
      </Td>
      <Td className={`${styles.mono} ${styles.nowrap}`}>{event.tool ?? '—'}</Td>
      <Td>
        {event.risk_ids.length === 0 ? (
          '—'
        ) : (
          <div className={styles.risks}>
            {event.risk_ids.map((risk) => (
              <span key={risk} className={`${styles.mono} ${styles.nowrap}`}>
                {risk}
                {event.remaining?.[risk] !== undefined && ` → ${event.remaining[risk]}`}
              </span>
            ))}
          </div>
        )}
      </Td>
      <Td>{event.agent_label ?? event.actor_email ?? '—'}</Td>
      <Td>
        {request && (
          <Link href={request.path} className={styles.nowrap}>
            open {request.kind}
          </Link>
        )}
        {!request && event.request_id && (
          <span className={styles.muted}>{event.request_kind ?? 'request'} (closed)</span>
        )}
        {event.token_prefix && <span className={styles.mono}>token {event.token_prefix}…</span>}
        {event.credits &&
          Object.entries(event.credits).map(([risk, given]) => (
            <div key={risk} className={`${styles.mono} ${styles.nowrap}`}>
              {risk} +{given} given back
            </div>
          ))}
        {event.dimension === 'expiry' && event.expires_at && (
          <div className={styles.muted}>
            expiry moved to <LocalDate ts={event.expires_at} />
          </div>
        )}
      </Td>
    </Tr>
  );
}
