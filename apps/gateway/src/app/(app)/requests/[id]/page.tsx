/**
 * `/requests/<id>` — the creator's view of one request (spec §3.4): the
 * mission, the risk concerned with its quota and what was consumed, the
 * remainder of the other risks, the last session events, and the four
 * actions, each with its consequence in one line.
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
  'request-not-open': 'The request was already answered, or it expired.',
  'unsupported-kind': 'Approval requests are handled in a later version.',
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
          The token does not change: the executor replays its call.
        </Banner>
      )}
      {problem && (
        <Banner tone="danger" title="Nothing was changed">
          {PROBLEM_SENTENCES[problem] ?? 'The decision was refused.'}
        </Banner>
      )}

      {view.kind === 'claim' ? (
        <ClaimBody view={view} />
      ) : (
        <Banner tone="info" title="Approval requests are handled in a later version">
          This request asks you to approve one action of the mission. This version of the gateway
          cannot record an approval yet; the request expires on its own and nothing runs meanwhile.
        </Banner>
      )}
    </Stack>
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
              <Outcome request={request} />
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

      <Card>
        <CardHeader>
          <CardTitle>Last session events</CardTitle>
        </CardHeader>
        {view.events.length === 0 ? (
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
              {view.events.map((event) => (
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

function Outcome({ request }: { request: RequestSummary }) {
  if (request.state === 'open') return <LocalDate ts={request.expires_at} />;
  if (request.state === 'expired') {
    return <>expired unanswered; the risk stays exhausted until the next period</>;
  }
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
