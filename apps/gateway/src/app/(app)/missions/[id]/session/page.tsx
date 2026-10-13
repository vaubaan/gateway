/**
 * `/missions/<id>/session` — the mission's session (spec §4.2, §3.3): counters
 * per risk and per period with what is left, gate per risk, open requests (by
 * link), the agent labels seen, and the event timeline.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LocalDate } from '@/components/LocalDate';
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
import {
  AUDIT_PARAMS,
  decodeCursor,
  encodeCursor,
  type MissionSessionView,
  type SessionEventView,
} from '@/server/audit';

import styles from '../../../audit/audit.module.css';
import { currentUser } from '../../current-user';
import { NeedsUser } from '../../needs-user';
import { StateBadge } from '../../state-badge';

export const dynamic = 'force-dynamic';

const EVENTS_CURSOR_PARAM = 'before';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function MissionSessionPage({ params, searchParams }: Props) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { id } = await params;
  const cursorRaw = (await searchParams)[EVENTS_CURSOR_PARAM];
  const cursor = typeof cursorRaw === 'string' ? decodeCursor(cursorRaw) : null;
  const view = await session.root.audit.sessions.get(session.user, id, { eventsBefore: cursor });
  if (!view) notFound();
  const { mission, state } = view;
  const base = `/missions/${encodeURIComponent(mission.id)}`;

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
        <Link href={`/audit?${AUDIT_PARAMS.mission}=${encodeURIComponent(mission.id)}`}>
          Audit of this mission
        </Link>
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

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        {view.events.length === 0 ? (
          <div className={styles.empty}>No event yet.</div>
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
        </span>
        <span>
          {cursor && <Link href={`${base}/session`}>Newest</Link>}
          {cursor && view.next_events && ' · '}
          {view.next_events && (
            <Link href={`${base}/session?${EVENTS_CURSOR_PARAM}=${encodeCursor(view.next_events)}`}>
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
