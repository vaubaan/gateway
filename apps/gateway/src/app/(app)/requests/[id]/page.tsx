/**
 * `/requests/<id>` — the creator's view of one request.
 *
 * A claim (spec §3.4): the mission, the risk concerned with its quota and
 * what was consumed, the remainder of the other risks, the last session
 * events, and the four actions, each with its consequence in one line.
 *
 * An approval request (spec §3.5): the tool, the arguments in clear, the
 * slices touched, what is left of every risk the call counts against, and
 * the three actions — approve this action, open the gate for the rest of the
 * period, refuse. The arguments are on this page only, for the creator only,
 * and only while the request is open.
 *
 * Reached from the inbox, or from the forwarded URL `/r/<id>` once its gate
 * has let the creator through. Anyone else reads one sentence and nothing
 * about the request.
 */
import Link from 'next/link';

import { LocalDate } from '@/components/LocalDate';
import { NeedsUser } from '@/components/auth/NeedsUser';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Input,
  Stack,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  type BadgeTone,
} from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import {
  ADDRESSED_TO_CREATOR,
  INBOX_PATH,
  type ApprovalOption,
  type ApprovalView,
  type ClaimOption,
  type ClaimView,
  type RequestSummary,
  type RiskBudgetLine,
} from '@/server/requests';
import type { RequestStatus } from '@vaubaan/shared';

import styles from '../requests.module.css';

export const dynamic = 'force-dynamic';

const STATE_TONE: Record<RequestStatus, BadgeTone> = {
  open: 'warning',
  granted: 'success',
  refused: 'neutral',
  expired: 'neutral',
};

/** What the page says after a refused form post (`?problem=<code>`). */
const PROBLEM_SENTENCES: Readonly<Record<string, string>> = {
  'invalid-decision': 'That is not a decision this request accepts.',
  'invalid-amount':
    'The amount must be a whole number between 1 and what was consumed on this risk in the current period.',
  'invalid-expiry': 'The new expiry must be a date later than the current one.',
  'mission-closed': 'The mission is revoked or orphaned: only a refusal can be recorded.',
  'mission-expired': 'The mission is expired: extend its expiry first.',
  'risk-not-in-policy': 'The mission no longer accepts this risk.',
  'nothing-consumed': 'Nothing was consumed on this risk in the current period.',
  'no-expiry': 'The mission never expires; there is nothing to extend.',
  'gate-not-closed': 'The gate of this risk is already open: calls pass without asking.',
  'no-period-end':
    'This mission has a single period that never ends: set the gate to auto on the mission page instead.',
  'request-not-open': 'The request was already answered, or it expired.',
  'unsupported-kind': 'That decision does not apply to this kind of request.',
};

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ decided?: string; problem?: string }>;
}

export default async function RequestPage({ params, searchParams }: Props) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { id } = await params;
  const result = await session.root.requests.service.view(session.user, id);
  if (result.outcome !== 'ok') {
    return <Banner tone="warning">{ADDRESSED_TO_CREATOR}</Banner>;
  }
  const { view } = result;
  const { decided, problem } = await searchParams;

  return (
    <Stack gap="var(--space-5)">
      <div className={styles.pageHead}>
        <div>
          <p className={styles.muted}>
            <Link href={INBOX_PATH}>Requests</Link> /
          </p>
          <h1>
            {view.kind === 'claim' ? 'Claim' : 'Approval request'} on {view.request.mission.name}{' '}
            <Badge tone={STATE_TONE[view.request.state]}>{view.request.state}</Badge>
          </h1>
        </div>
      </div>

      {decided && view.request.state !== 'open' && (
        <Banner tone="success" title="Decision recorded">
          {view.kind === 'approval' && view.request.state === 'granted'
            ? 'The token does not change: the executor replays its call with exactly the same arguments.'
            : 'The token does not change: the executor replays its call.'}
        </Banner>
      )}
      {problem && (
        <Banner tone="danger" title="Nothing was changed">
          {PROBLEM_SENTENCES[problem] ?? 'The decision was refused.'}
        </Banner>
      )}

      {view.kind === 'claim' ? <ClaimBody view={view} /> : <ApprovalBody view={view} />}
    </Stack>
  );
}

function ApprovalBody({ view }: { view: ApprovalView }) {
  const { request, mission, call, gate, approval, period } = view;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>What is asked</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className={styles.facts}>
            <dt>Mission</dt>
            <dd>
              <Link href={`/missions/${mission.id}`}>{mission.name}</Link>{' '}
              <Badge tone={mission.state === 'active' ? 'success' : 'warning'}>
                {mission.state}
              </Badge>
            </dd>
            <dt>Tool</dt>
            <dd className={styles.mono} data-testid="approval-tool">
              {call.tool}
            </dd>
            <dt>Arguments</dt>
            <dd>
              {call.arguments_erased ? (
                <span className={styles.muted} data-testid="approval-arguments-erased">
                  erased when the request was {request.state === 'expired' ? 'closed' : 'decided'};
                  only their fingerprint remains
                </span>
              ) : (
                <pre className={styles.arguments} data-testid="approval-arguments">
                  {JSON.stringify(call.arguments, null, 2)}
                </pre>
              )}
            </dd>
            <dt>Fingerprint</dt>
            <dd className={styles.mono} data-testid="approval-fingerprint">
              {call.fingerprint}
            </dd>
            <dt>Slices touched</dt>
            <dd data-testid="approval-slices">
              {call.slices === null ? (
                <span className={styles.muted}>not recorded</span>
              ) : (
                call.slices.map((slice) => (
                  <div key={slice} className={styles.mono}>
                    {slice}
                  </div>
                ))
              )}
            </dd>
            <dt>Gated risk</dt>
            <dd>
              {request.risk_label}
              <div className={styles.mono}>{request.risk_id}</div>
            </dd>
            <dt>Gate</dt>
            <dd data-testid="approval-gate">
              <GateLine gate={gate} />
            </dd>
            <dt>Period ends</dt>
            <dd>
              {period.end ? <LocalDate ts={period.end} /> : 'never (one-off mission, one period)'}
            </dd>
            <dt>Asked</dt>
            <dd>
              <LocalDate ts={request.created_at} />
            </dd>
            <dt>{request.state === 'open' ? 'Expires unanswered' : 'Outcome'}</dt>
            <dd data-testid="approval-outcome">
              <Outcome request={request} expired="expired unanswered; nothing ran" />
              {approval && (
                <div className={styles.muted}>
                  {approval.state === 'consumed' && approval.consumed_at ? (
                    <>
                      approval consumed by the replay on <LocalDate ts={approval.consumed_at} />
                    </>
                  ) : approval.state === 'expired' ? (
                    <>
                      approval expired unused on <LocalDate ts={approval.expires_at} />
                    </>
                  ) : (
                    <>
                      approval usable once until <LocalDate ts={approval.expires_at} />
                    </>
                  )}
                </div>
              )}
            </dd>
          </dl>
        </CardBody>
      </Card>

      {view.options.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Your decision</CardTitle>
          </CardHeader>
          <div className={`${styles.actions} ${styles.actionsWide}`}>
            {view.options.map((option) => (
              <ApprovalAction key={option.resolution} requestId={request.id} option={option} />
            ))}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>What this call counts against, this period</CardTitle>
        </CardHeader>
        <Table>
          <Thead>
            <Tr>
              <Th>Risk</Th>
              <Th>Gate</Th>
              <Th>Quota</Th>
              <Th>Consumed</Th>
              <Th>Left</Th>
            </Tr>
          </Thead>
          <Tbody>
            {call.risks.map((line) => (
              <Tr key={line.risk_id} data-testid={`approval-risk-${line.risk_id}`}>
                <Td>
                  {line.label}
                  <div className={styles.mono}>{line.risk_id}</div>
                </Td>
                <Td>
                  {line.gate === 'approval' ? <Badge tone="warning">approval</Badge> : 'auto'}
                </Td>
                <Td>{line.quota}</Td>
                <Td>{line.consumed}</Td>
                <Td>
                  {line.remaining === 0 ? <Badge tone="warning">exhausted</Badge> : line.remaining}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Card>

      <EventsCard events={view.events} />
    </>
  );
}

function GateLine({ gate }: { gate: ApprovalView['gate'] }) {
  if (gate.policy === null) return <>the mission no longer accepts this risk</>;
  if (gate.policy === 'auto') return <>auto on the mission: calls pass without asking</>;
  if (gate.open_until) {
    return (
      <>
        approval, open until <LocalDate ts={gate.open_until} />
      </>
    );
  }
  return <>approval: each action asks you</>;
}

function ApprovalAction({ requestId, option }: { requestId: string; option: ApprovalOption }) {
  const disabled = option.unavailable !== null;
  return (
    <div className={styles.action} data-testid={`action-${option.resolution}`}>
      <form method="post" action={`/api/requests/${requestId}/decide`}>
        <input type="hidden" name="resolution" value={option.resolution} />
        <Button
          type="submit"
          variant={option.resolution === 'grant' ? 'primary' : 'secondary'}
          disabled={disabled}
        >
          {option.label}
        </Button>
        <div>
          <div className={styles.consequence}>{option.consequence}</div>
          {option.unavailable && (
            <div className={styles.unavailable}>Unavailable: {option.unavailable.message}</div>
          )}
        </div>
      </form>
    </div>
  );
}

function EventsCard({ events }: { events: ClaimView['events'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Last session events</CardTitle>
      </CardHeader>
      {events.length === 0 ? (
        <CardBody className={styles.muted}>No event yet.</CardBody>
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>When</Th>
              <Th>Event</Th>
              <Th>Risk</Th>
            </Tr>
          </Thead>
          <Tbody>
            {events.map((event) => (
              <Tr key={event.id}>
                <Td>
                  <LocalDate ts={event.at} />
                </Td>
                <Td>{event.summary}</Td>
                <Td className={styles.mono}>{event.risk_id ?? '—'}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  );
}

function ClaimBody({ view }: { view: ClaimView }) {
  const { request, mission, risk, period } = view;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>What is asked</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className={styles.facts}>
            <dt>Mission</dt>
            <dd>
              <Link href={`/missions/${mission.id}`}>{mission.name}</Link>{' '}
              <Badge tone={mission.state === 'active' ? 'success' : 'warning'}>
                {mission.state}
              </Badge>
            </dd>
            <dt>Risk</dt>
            <dd>
              {request.risk_label}
              <div className={styles.mono}>{request.risk_id}</div>
            </dd>
            <dt>This period</dt>
            <dd data-testid="claim-budget">
              {risk
                ? `quota ${risk.quota} · consumed ${risk.consumed} · ${risk.remaining} left`
                : 'the mission no longer accepts this risk'}
            </dd>
            <dt>Period ends</dt>
            <dd>
              {period.end ? <LocalDate ts={period.end} /> : 'never (one-off mission, one period)'}
            </dd>
            <dt>Mission expiry</dt>
            <dd>{mission.expires_at ? <LocalDate ts={mission.expires_at} /> : 'never'}</dd>
            <dt>Asked</dt>
            <dd>
              <LocalDate ts={request.created_at} />
            </dd>
            <dt>{request.state === 'open' ? 'Expires unanswered' : 'Outcome'}</dt>
            <dd>
              <Outcome
                request={request}
                expired="expired unanswered; the risk stays exhausted until the next period"
              />
            </dd>
          </dl>
        </CardBody>
      </Card>

      {view.options.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Your decision</CardTitle>
          </CardHeader>
          <div className={styles.actions}>
            {view.options.map((option) => (
              <Action key={option.resolution} requestId={request.id} option={option} />
            ))}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Other risks this period</CardTitle>
        </CardHeader>
        {view.other_risks.length === 0 ? (
          <CardBody className={styles.muted}>The mission accepts no other risk.</CardBody>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Risk</Th>
                <Th>Quota</Th>
                <Th>Consumed</Th>
                <Th>Left</Th>
              </Tr>
            </Thead>
            <Tbody>
              {view.other_risks.map((line) => (
                <RiskRow key={line.risk_id} line={line} />
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      <EventsCard events={view.events} />
    </>
  );
}

function RiskRow({ line }: { line: RiskBudgetLine }) {
  return (
    <Tr>
      <Td>
        {line.label}
        <div className={styles.mono}>{line.risk_id}</div>
      </Td>
      <Td>{line.quota}</Td>
      <Td>{line.consumed}</Td>
      <Td>{line.remaining === 0 ? <Badge tone="warning">exhausted</Badge> : line.remaining}</Td>
    </Tr>
  );
}

/** `expired` is what an unanswered request of this kind leaves behind, in words. */
function Outcome({ request, expired }: { request: RequestSummary; expired: string }) {
  if (request.state === 'open') return <LocalDate ts={request.expires_at} />;
  if (request.state === 'expired') return <>{expired}</>;
  const resolution = request.decision?.resolution;
  return (
    <>
      {request.state}
      {typeof resolution === 'string' && resolution !== 'refuse' && ` (${resolution})`}
      {request.decided_at && (
        <>
          {' '}
          on <LocalDate ts={request.decided_at} />
        </>
      )}
    </>
  );
}

/** `2026-11-01T10:00` for a `datetime-local` input, read as UTC by the server. */
function minuteOf(iso: string): string {
  return iso.slice(0, 16);
}

function Action({ requestId, option }: { requestId: string; option: ClaimOption }) {
  const disabled = option.unavailable !== null;
  return (
    <div className={styles.action} data-testid={`action-${option.resolution}`}>
      <form method="post" action={`/api/requests/${requestId}/decide`}>
        <input type="hidden" name="resolution" value={option.resolution} />
        <Button
          type="submit"
          variant={option.resolution === 'refuse' ? 'secondary' : 'primary'}
          disabled={disabled}
        >
          {option.label}
        </Button>
        <div>
          <div className={styles.consequence}>{option.consequence}</div>
          {!disabled && option.resolution === 'extend-quota' && (
            <label className={styles.inline}>
              Actions to give back
              <Input
                type="number"
                name="amount"
                min={1}
                max={option.max_amount}
                defaultValue={option.max_amount}
                required
              />
            </label>
          )}
          {!disabled && option.resolution === 'extend-expiry' && (
            <label className={styles.inline}>
              New expiry (UTC)
              <Input
                type="datetime-local"
                name="expires_at"
                min={option.after ? minuteOf(option.after) : undefined}
                required
              />
            </label>
          )}
          {option.unavailable && (
            <div className={styles.unavailable}>Unavailable: {option.unavailable.message}</div>
          )}
        </div>
      </form>
    </div>
  );
}
