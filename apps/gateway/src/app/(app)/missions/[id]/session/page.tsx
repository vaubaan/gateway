/**
 * `/missions/<id>/session` — the mission's session (spec §4.2, §3.3): counters
 * per risk and per period with what is left, gate per risk (and until when
 * the creator opened it), open requests (by link), the calls of the current
 * period per token holder and per agent label, and the event timeline — whole,
 * the calls of one holder (`?holder=member:<user id>`, `?holder=named:<name>`)
 * or the calls of one label (`?agent=<label>`, `?unlabelled=1`). What the Detail
 * column says of an event is `eventDetailLines` (`@/server/audit`).
 *
 * A token holder is authenticated: it is whose token the call presented (spec
 * §8). An agent label is what a caller declared about itself (spec §0, §7.9):
 * the page says so wherever it shows one. Both tables are counts of calls, not
 * budgets: a mission has one budget, however many tokens or agents.
 *
 * The creator and the members of the mission read this page (spec §11.2 "What
 * a member sees"); only the creator is given the links that answer a request.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LocalDate } from '@/components/LocalDate';
import { NeedsUser } from '@/components/auth/NeedsUser';
import {
  Badge,
  type BadgeTone,
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
  Slug,
} from '@/components/ui';
import { GateBadge } from '@/components/risk/RiskBadges';
import { RiskIdLink } from '@/components/risk/RiskExplain';
import { currentUser } from '@/lib/auth/session';
import type { SessionEventKind } from '@vaubaan/shared';
import {
  ALL_EVENTS,
  AUDIT_PARAMS,
  decodeCursor,
  encodeCursor,
  eventDetailLines,
  holderParam,
  isSessionEventKind,
  parseHolderParam,
  type MissionSessionView,
  type SessionEventView,
  type SessionHolderView,
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
/** Timeline filter: the calls made with a token of one holder. */
const HOLDER_PARAM = 'holder';
const MAX_LABEL_PARAM_LENGTH = 200;

type SearchParams = Record<string, string | string[] | undefined>;

function timelineFilterOf(params: SearchParams): SessionTimelineFilter {
  const holderRaw = params[HOLDER_PARAM];
  if (typeof holderRaw === 'string' && holderRaw.length <= MAX_LABEL_PARAM_LENGTH) {
    const holder = parseHolderParam(holderRaw);
    if (holder) return { kind: 'holder', holder };
  }
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
  if (filter.kind === 'holder') params.set(HOLDER_PARAM, holderParam(filter.holder));
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
  // The Audit page lists the entries of the missions one created: a member reads the session.
  const isCreator = view.viewer_role === 'creator';
  const filteredHolder =
    filter.kind === 'holder'
      ? (view.holder_activity.find(
          (a) => a.holder?.kind === filter.holder.kind && a.holder.key === filter.holder.key,
        )?.holder ?? { ...filter.holder, label: filter.holder.key })
      : null;

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
        {/* The creator and the members both read it (spec §4.2); a member is shown no fingerprint. */}
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
                  <div>
                    <RiskIdLink riskId={risk.risk_id} />
                  </div>
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
                <Td data-testid={`gate-${risk.risk_id}`}>
                  <GateBadge gate={risk.gate} />
                  {risk.gate_open_until && (
                    <div className={styles.muted}>
                      open until <LocalDate ts={risk.gate_open_until} />
                    </div>
                  )}
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
                      <RiskIdLink riskId={risk.risk_id} />
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
        {!isCreator && view.open_requests.length > 0 && (
          <CardBody>
            <p className={styles.muted} data-testid="requests-are-the-creators">
              Requests are answered by the creator of the mission alone. You see that they are
              waiting; you cannot answer them.
            </p>
          </CardBody>
        )}
        {view.open_requests.length === 0 ? (
          <div className={styles.empty}>
            {isCreator
              ? 'No request is waiting for you on this mission.'
              : 'No request is waiting for the creator on this mission.'}
          </div>
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
                    {request.path ? (
                      <Link href={request.path}>
                        {request.kind === 'claim' ? 'Claim' : 'Approval request'}
                      </Link>
                    ) : request.kind === 'claim' ? (
                      'Claim'
                    ) : (
                      'Approval request'
                    )}
                  </Td>
                  <Td className={styles.mono}>
                    <RiskIdLink riskId={request.risk_id} />
                  </Td>
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

      <Card data-testid="holder-activity">
        <CardHeader>
          <CardTitle>Calls per token holder — current period</CardTitle>
        </CardHeader>
        <CardBody>
          <p className={styles.muted}>
            For information only: this is not a budget. A holder is whose token the call presented —
            a member of the mission, or a named token — and is authenticated by that token. Every
            token of the mission draws from the same budget per risk, above.
          </p>
        </CardBody>
        {state.kind !== 'active' ? (
          <div className={styles.empty}>No current period: the mission is {state.kind}.</div>
        ) : view.holder_activity.length === 0 ? (
          <div className={styles.empty}>No call in this period yet.</div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Token holder</Th>
                <Th>Calls allowed</Th>
                <Th>Calls refused</Th>
                <Th>Last call</Th>
                <Th>Show</Th>
              </Tr>
            </Thead>
            <Tbody>
              {view.holder_activity.map((activity) => {
                const { holder } = activity;
                return (
                  <Tr key={holder ? holderParam(holder) : ''} data-holder={holder?.label ?? ''}>
                    <Td>
                      <HolderName holder={holder} />
                    </Td>
                    <Td>{activity.allowed}</Td>
                    <Td>{activity.refused}</Td>
                    <Td>
                      <LocalDate ts={activity.last_seen_at} />
                    </Td>
                    <Td className={styles.nowrap}>
                      {holder ? (
                        <>
                          <Link
                            href={`${sessionPath}${sessionQuery({ kind: 'holder', holder }, null)}`}
                          >
                            in the timeline
                          </Link>
                          {isCreator && (
                            <>
                              {' · '}
                              <Link
                                href={`${auditOfMission}&${AUDIT_PARAMS.holder}=${encodeURIComponent(holderParam(holder))}`}
                              >
                                in the audit
                              </Link>
                            </>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>
                  </Tr>
                );
              })}
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
                      {activity.label !== null && isCreator && (
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

      <Card data-testid="timeline" className={styles.wide}>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardBody>
          <p className={styles.muted} data-testid="timeline-retention">
            Kept {session.root.config.retentionDays} days, like the audit: older events are deleted,
            and so are the counters of periods that ended longer ago.
          </p>
        </CardBody>
        {filter.kind !== 'all' && (
          <CardBody>
            <p className={styles.muted} data-testid="timeline-filter">
              {filter.kind === 'holder' ? (
                <>
                  Calls made with a token of <HolderName holder={filteredHolder} /> only
                </>
              ) : filter.kind === 'label' ? (
                <>
                  Calls labelled <Badge mono>{filter.label}</Badge> only
                </>
              ) : (
                'Calls without an agent label only'
              )}
              ; requests, resets and other events are not calls and are not listed.{' '}
              <Link href={sessionPath}>Show the whole timeline</Link>
            </p>
          </CardBody>
        )}
        {view.events.length === 0 ? (
          <div className={styles.empty}>
            {filter.kind === 'all' ? 'No event yet.' : 'No call matches on this page.'}
          </div>
        ) : (
          <div className={styles.scroll} data-testid="timeline-table">
            <Table>
              <Thead>
                <Tr>
                  <Th>When</Th>
                  <Th>Event</Th>
                  <Th>Tool</Th>
                  <Th>Risks → left</Th>
                  <Th>Token holder</Th>
                  <Th>Agent label / actor</Th>
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

/** A member by their email, a named token by its name with its kind; `null`: not attributed. */
function HolderName({ holder }: { holder: SessionHolderView | null }) {
  if (!holder) {
    return <span className={styles.muted}>not attributed (before tokens had a holder)</span>;
  }
  return holder.kind === 'member' ? (
    <Slug kind="member" mono={false}>
      {holder.label}
    </Slug>
  ) : (
    <>
      <Slug kind="token" mono={false}>
        {holder.label}
      </Slug>{' '}
      <Badge>named token</Badge>
    </>
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

const EVENT_TONE: Readonly<Record<SessionEventKind, BadgeTone>> = {
  'call-allowed': 'success',
  'call-refused': 'danger',
  request: 'warning',
  reset: 'info',
  extension: 'info',
  approval: 'info',
  'gate-opened': 'info',
  'gate-changed': 'neutral',
  rotation: 'neutral',
  revocation: 'danger',
};

/** A kind written by a later version has no tone of its own. */
function toneOf(kind: string): BadgeTone {
  return isSessionEventKind(kind) ? EVENT_TONE[kind] : 'neutral';
}

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
        <span className={styles.nowrap}>
          <Badge tone={toneOf(event.kind)}>{event.kind}</Badge>
        </span>
        {event.refusal_code && <div className={styles.mono}>{event.refusal_code}</div>}
      </Td>
      <Td className={`${styles.mono} ${styles.tool}`}>
        {event.tool ? <Slug kind="tool">{event.tool}</Slug> : '—'}
      </Td>
      <Td>
        {event.risk_ids.length === 0 ? (
          '—'
        ) : (
          <div className={styles.risks}>
            {event.risk_ids.map((risk) => (
              <span key={risk} className={`${styles.mono} ${styles.wraps}`}>
                <RiskIdLink riskId={risk} />
                {event.remaining?.[risk] !== undefined && ` → ${event.remaining[risk]}`}
              </span>
            ))}
          </div>
        )}
      </Td>
      <Td className={styles.holder} data-testid="event-holder">
        {event.holder ? <HolderName holder={event.holder} /> : '—'}
      </Td>
      <Td>{event.agent_label ?? event.actor_email ?? '—'}</Td>
      <Td className={styles.detail} data-testid="event-detail">
        {eventDetailLines(event, { requestOpen: request !== undefined }).map((line) => (
          <div key={line.text} className={line.mono ? styles.mono : styles.muted}>
            {line.text}
            {line.at && (
              <>
                {' '}
                <LocalDate ts={line.at} />
              </>
            )}
          </div>
        ))}
        {request &&
          (request.path ? (
            <Link href={request.path}>open {request.kind}</Link>
          ) : (
            <span className={styles.muted}>{request.kind} waiting for the creator</span>
          ))}
      </Td>
    </Tr>
  );
}
