import { PermissionsEditor } from '../missions/[id]/permissions-editor';
/**
 * One request, as its creator reads it — in the order they need it: who asks
 * and on which mission, exactly what will run (the call, its arguments, the
 * permission and its severity), what an answer changes, then the answers.
 * Context comes after: what led here, and what the agent sees meanwhile.
 *
 * An approval (spec §3.5) and a limit that was reached (spec §3.4) share the
 * frame and differ by their answers. A request that is not open any more —
 * answered, expired — shows what became of it and no answer; an open request
 * on a mission that cannot run shows why, and only the answer that still
 * applies.
 *
 * The arguments are on this page only, for the creator only, and only while
 * the request is open (handbook requests).
 */
import Link from 'next/link';

import { LocalDate } from '@/components/LocalDate';
import {
  AgentLabel,
  ArgList,
  Button,
  Callout,
  CallBox,
  CodeBlock,
  CodeTone,
  ContextColumns,
  DataTable,
  DecideBar,
  Disclosure,
  FactColumns,
  Feed,
  FeedEvent,
  GateMark,
  Hint,
  KeyValue,
  Mono,
  RequestStatement,
  SectionHeading,
  SeverityChip,
  StatusMark,
  type ArgItem,
  type Column,
} from '@/components/ui';
import {
  agoSentence,
  ANSWERS,
  count,
  delay,
  everyOf,
  formatNumber,
  GATE_WORDS,
  keyOf,
  LIMIT_WORDS,
  periodNow,
  perPeriod,
  REQUEST_STATES,
  REQUEST_WORDS,
  ROUTES,
  roomLeft,
  TERMS,
  until,
  usedOf,
  WAITING,
  type SeverityWord,
} from '@/lib/vocabulary';
import { riskReferencePath } from '@/server/providers/links';
import type {
  ApprovalOption,
  ApprovalView,
  ClaimOption,
  ClaimView,
  RequestAsker,
  RequestView as View,
  RiskBudgetLine,
  SessionEventLine,
} from '@/server/requests';
import type { RiskId } from '@vaubaan/shared';

import { eventWords } from './event-words';
import { LimitAnswer, type LimitChoice } from './limit-answer';
import { LocalTime } from './local-time';
import { CallHeadline, whoOf } from './parts';
import styles from './waiting.module.css';

/** How many events "What led here" shows before "Mission activity" takes over. */
const EVENTS_SHOWN = 6;

export interface RequestViewProps {
  readonly view: View;
  readonly viewerId: string;
  readonly now: Date;
  /** The severity of each permission of the request, from the catalogs; absent when unknown. */
  readonly levels: Readonly<Record<RiskId, SeverityWord | undefined>>;
  /** The person just answered (`?decided=1`). */
  readonly decided: boolean;
  /** Why the last answer was not taken (`?problem=<code>`); `null` otherwise. */
  readonly problem: string | null;
}

/** What the page says after an answer the server did not take, by its code. */
const PROBLEM_SENTENCES: Readonly<Record<string, string>> = {
  'invalid-decision': 'That is not an answer this request takes.',
  'invalid-amount':
    'The number of calls to give back is a whole number, at least 1 and at most what was used since the last reset.',
  'invalid-expiry': 'The new end must be later than the current one.',
  'mission-closed':
    'The mission cannot run any more: only a refusal can be recorded on it. If the access behind it comes back, the request can be answered then, until it expires.',
  'mission-expired': 'The mission has ended: extend it first.',
  'risk-not-in-policy': 'The mission no longer includes this permission.',
  'nothing-consumed': 'Nothing was used on this permission since the last reset.',
  'no-expiry': 'The mission has no end date; there is nothing to extend.',
  'gate-not-closed': 'This permission already runs freely: calls pass without asking you.',
  'no-period-end':
    'The limits of this mission never reset, so there is no “until the reset”. Set the permission to run freely on the mission instead.',
  'request-not-open': 'The request was already answered, or it expired.',
  'unsupported-kind': 'That answer does not apply to this kind of request.',
};

function missionPath(id: string): string {
  return `${ROUTES.missions}/${id}`;
}

/** "codex using Carol’s key", "An agent using the machine key nightly", "An agent". */
function Asking({ asker, viewerId }: { asker: RequestAsker | null; viewerId: string }) {
  const who = whoOf(asker, viewerId);
  const key = who.holder
    ? keyOf({ name: who.holder, you: who.you, machine: who.machine })
    : who.machine
      ? 'a machine key'
      : null;
  return (
    <>
      {who.agent ? <AgentLabel>{who.agent}</AgentLabel> : 'An agent'}
      {key && (
        <>
          {' '}
          using <b>{key}</b>
        </>
      )}
    </>
  );
}

function StateMark({ request }: { request: View['request'] }) {
  if (request.state === 'open') return null;
  // A limit that was reached is answered or left, not approved.
  const label =
    request.kind === 'claim' && request.state !== 'expired'
      ? request.state === 'granted'
        ? REQUEST_WORDS.limitAnswered
        : REQUEST_WORDS.limitLeft
      : REQUEST_STATES[request.state].label;
  return <StatusMark testId="request-state">{label}</StatusMark>;
}

/** The notes that interrupt: the answer just given, an answer not taken, a mission that cannot run. */
function Notices({
  view,
  decided,
  problem,
}: Pick<RequestViewProps, 'view' | 'decided' | 'problem'>) {
  const { request, mission } = view;
  const closedMission =
    request.state === 'open' && mission.state !== 'active' ? mission.state : null;
  return (
    <>
      {decided && request.state !== 'open' && (
        <div className={styles.notice}>
          <Callout tone="ok" title="Answer recorded" testId="request-decided">
            {request.state === 'granted'
              ? 'The key does not change: the agent retries its call on its own.'
              : 'Nothing changed for the agent.'}{' '}
            {WAITING.recorded}
          </Callout>
        </div>
      )}
      {problem && (
        <div className={styles.notice}>
          <Callout tone="bad" title="Nothing was changed" testId="request-problem">
            {PROBLEM_SENTENCES[problem] ?? 'The answer was not taken.'}
          </Callout>
        </div>
      )}
      {closedMission && (
        <div className={styles.notice}>
          <Callout tone="bad" title="This mission cannot run" testId="request-mission-closed">
            {closedMission === 'revoked' &&
              'The mission was stopped: every call is refused whatever you answer. You can only dismiss this request.'}
            {closedMission === 'orphaned' && (
              <>
                The access behind the mission is missing, so every call is refused whatever you
                answer. If that access comes back before this request expires (
                <LocalDate ts={request.expires_at} />
                ), it can be answered then.
              </>
            )}
            {closedMission === 'expired' &&
              'The mission has ended: every call is refused until it is extended.'}
          </Callout>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// What led here, and what the agent sees
// ─────────────────────────────────────────────────────────────────────────────

function EventLine({ event }: { event: SessionEventLine }) {
  const words = eventWords(event);
  return (
    <FeedEvent time={<LocalTime ts={event.at} />} tone={words.tone}>
      {words.call && <>{words.agent ? <AgentLabel>{words.agent}</AgentLabel> : 'An agent'} </>}
      {words.text}
      {words.tool && (
        <>
          {' '}
          <Mono>{words.tool}</Mono>
        </>
      )}
      {words.until && (
        <>
          {words.tool ? ', ' : ' '}
          {words.untilWords} <LocalDate ts={words.until} />
        </>
      )}
      {words.code && (
        <>
          {' '}
          · <Mono quiet>{words.code}</Mono>
        </>
      )}
    </FeedEvent>
  );
}

function Context({ view, children }: { view: View; children: React.ReactNode }) {
  const events = view.events.slice(0, EVENTS_SHOWN);
  return (
    <ContextColumns>
      <section aria-labelledby="led-here">
        <SectionHeading
          title={REQUEST_WORDS.whatLedHere}
          id="led-here"
          note={
            <Link href={`${missionPath(view.mission.id)}/session`}>
              {REQUEST_WORDS.missionActivity}
            </Link>
          }
        />
        {events.length === 0 ? (
          <Hint>Nothing was recorded on this mission yet.</Hint>
        ) : (
          <Feed label={REQUEST_WORDS.whatLedHere} testId="request-events">
            {events.map((event) => (
              <EventLine key={event.id} event={event} />
            ))}
          </Feed>
        )}
      </section>
      {view.request.state === 'open' && (
        <section aria-labelledby="agent-sees">
          <SectionHeading title={REQUEST_WORDS.agentSees} id="agent-sees" />
          {children}
        </section>
      )}
    </ContextColumns>
  );
}

/** The refusal the agent got, as the protocol spells it: the code, the permission, the link. */
function AgentSees({
  code,
  riskId,
  urlField,
  url,
}: {
  code: string;
  riskId: string;
  urlField: string;
  url: string;
}) {
  const field = (name: string, value: string, last = false) => (
    <>
      {'  '}
      <CodeTone tone="key">&quot;{name}&quot;</CodeTone>:{' '}
      <CodeTone tone="string">&quot;{value}&quot;</CodeTone>
      {last ? '\n' : ',\n'}
    </>
  );
  return (
    <CodeBlock copy={false} wrap label="The refusal the agent received" testId="agent-sees">
      {'{\n'}
      {field('code', code)}
      {field('risk_id', riskId)}
      {field(urlField, url, true)}
      {'}'}
    </CodeBlock>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// An approval
// ─────────────────────────────────────────────────────────────────────────────

/** A value as it was sent: a string as it is, anything else as JSON. */
function printed(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function argumentsOf(args: unknown): ArgItem[] {
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>);
    if (entries.length > 0)
      return entries.map(([name, value]) => ({ name, value: printed(value) }));
  }
  return [{ name: 'arguments', value: printed(args) }];
}

function GateNow({ gate }: { gate: ApprovalView['gates'][number] }) {
  if (gate.policy === null) return <span>no longer included in the mission</span>;
  if (gate.policy === 'auto') return <GateMark gate="free">now runs freely</GateMark>;
  if (gate.open_until) {
    return (
      <GateMark gate="free">
        runs freely until <LocalDate ts={gate.open_until} />
      </GateMark>
    );
  }
  return <GateMark gate="ask" />;
}

function PermissionLine({
  gate,
  level,
}: {
  gate: ApprovalView['gates'][number];
  level: SeverityWord | undefined;
}) {
  const href = riskReferencePath(gate.risk_id);
  return (
    <div className={styles.permission} data-testid="approval-permission">
      <span data-testid="approval-gate">
        <GateNow gate={gate} />
      </span>{' '}
      · {gate.label}
      {level && (
        <>
          {' '}
          · <SeverityChip level={level} />
        </>
      )}
      <div>
        <Mono quiet href={href ?? undefined} title="What this permission allows, in the reference">
          {gate.risk_id}
        </Mono>
      </div>
    </div>
  );
}

/** What is left of one permission: once this call has run while it waits, as it is afterwards. */
function RoomAfter({
  line,
  period,
  waiting,
}: {
  line: RiskBudgetLine;
  period: string;
  waiting: boolean;
}) {
  if (!waiting) {
    return (
      <div data-testid={`approval-room-${line.risk_id}`}>
        {roomLeft(line.remaining, line.quota, period)}
        <span className={styles.quiet}> · {line.label}</span>
      </div>
    );
  }
  if (line.remaining === 0) {
    return (
      <div className={styles.none} data-testid={`approval-room-${line.risk_id}`}>
        {line.label}: {LIMIT_WORDS.limitReached.toLowerCase()} — the call would be refused even with
        your yes
      </div>
    );
  }
  return (
    <div data-testid={`approval-room-${line.risk_id}`}>
      {roomLeft(line.remaining - 1, line.quota, period)}
      <span className={styles.quiet}> · {line.label}</span>
    </div>
  );
}

/** What the call counts against: the permissions that ask first, then the ones that run freely. */
function roomLines(view: ApprovalView): readonly RiskBudgetLine[] {
  const asked = new Set(view.gates.map((gate) => gate.risk_id));
  return [
    ...view.call.risks.filter((line) => asked.has(line.risk_id)),
    ...view.call.risks.filter((line) => !asked.has(line.risk_id)),
  ];
}

function approvalConsequence(option: ApprovalOption, view: ApprovalView): React.ReactNode {
  const many = view.gates.length > 1;
  switch (option.resolution) {
    case 'grant':
      return (
        <>
          Valid {delay(view.approval_valid_seconds)}, for exactly this call; the agent retries it on
          its own. Anything different asks again.
          {many && ` One yes covers the ${view.gates.length} permissions this call needs.`}
        </>
      );
    case 'open-gate':
      return (
        <>
          Every call that needs {many ? 'these permissions' : 'this permission'} runs without asking
          you
          {view.period.end ? (
            <>
              {' '}
              until <LocalDate ts={view.period.end} />
            </>
          ) : (
            ' until the reset'
          )}
          , this one included and whatever its arguments, within the limits. It asks again after
          that.
        </>
      );
    case 'refuse':
      return 'Nothing runs. If the agent retries, it is refused again and asks again.';
  }
}

function unavailableWords(
  code: string,
  missionState: View['mission']['state'],
  fallback: string,
): string {
  if (code === 'mission-closed') {
    return missionState === 'orphaned'
      ? 'the access behind the mission is missing'
      : 'the mission was stopped';
  }
  if (code === 'mission-expired') return 'the mission has ended';
  if (code === 'risk-not-in-policy') return 'the mission no longer includes this permission';
  if (code === 'gate-not-closed') return 'it already runs freely';
  if (code === 'no-period-end') return 'the limits of this mission never reset';
  if (code === 'nothing-consumed') return 'nothing was used since the last reset';
  if (code === 'no-expiry') return 'the mission has no end date';
  return fallback;
}

/** The order the answers are read and offered in: yes, no, then the quieter alternative. */
const ANSWER_ORDER: readonly ApprovalOption['resolution'][] = ['grant', 'refuse', 'open-gate'];

function ApprovalAnswers({ view }: { view: ApprovalView }) {
  const { request, mission } = view;
  const options = ANSWER_ORDER.flatMap((resolution) =>
    view.options.filter((option) => option.resolution === resolution),
  );
  const variantOf = (resolution: ApprovalOption['resolution']) =>
    resolution === 'grant' ? 'primary' : resolution === 'refuse' ? 'secondary' : 'ghost';
  return (
    <section aria-labelledby="your-answer" className={styles.answer}>
      <h3 id="your-answer" className={styles.answerTitle}>
        {REQUEST_WORDS.yourAnswer}
      </h3>
      <dl className={styles.consequences}>
        {options.map((option) => (
          <div key={option.resolution} data-testid={`consequence-${option.resolution}`}>
            <dt>{ANSWERS[option.resolution].label}</dt>
            <dd>
              {approvalConsequence(option, view)}
              {option.unavailable && (
                <span className={styles.unavailable}>
                  {' '}
                  Not possible now:{' '}
                  {unavailableWords(
                    option.unavailable.code,
                    mission.state,
                    option.unavailable.message,
                  )}
                  .
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <DecideBar>
        {options.map((option) => (
          <form
            key={option.resolution}
            method="post"
            action={`/api/requests/${request.id}/decide`}
            className={option.resolution === 'open-gate' ? styles.alternative : undefined}
            data-testid={`action-${option.resolution}`}
          >
            <input type="hidden" name="resolution" value={option.resolution} />
            <Button
              type="submit"
              size="lg"
              variant={variantOf(option.resolution)}
              disabled={option.unavailable !== null}
            >
              {ANSWERS[option.resolution].label}
            </Button>
          </form>
        ))}
      </DecideBar>
      <Hint>{REQUEST_WORDS.eitherAnswer}</Hint>
    </section>
  );
}

function ApprovalOutcome({ view, now }: { view: ApprovalView; now: Date }) {
  const { request, approval } = view;
  if (request.state === 'open') return null;
  const when = request.decided_at ? agoSentence(request.decided_at, now) : '';
  const resolution = request.decision?.resolution;
  return (
    <p className={styles.outcome} data-testid="approval-outcome">
      {request.state === 'expired' && (
        <>
          Nobody answered before <LocalDate ts={request.expires_at} />: the request expired and
          nothing ran.
        </>
      )}
      {request.state === 'refused' && <>You refused {when}. Nothing ran.</>}
      {request.state === 'granted' && resolution === 'open-gate' && (
        <>
          {ANSWERS['open-gate'].done} {when}: calls that need it pass without asking.
        </>
      )}
      {request.state === 'granted' && resolution !== 'open-gate' && (
        <>
          {ANSWERS.grant.done} {when}.{' '}
          {approval?.state === 'consumed' && approval.consumed_at && (
            <>
              The agent ran it on <LocalDate ts={approval.consumed_at} />.
            </>
          )}
          {approval?.state === 'expired' && (
            <>
              Your yes expired unused on <LocalDate ts={approval.expires_at} />: nothing ran.
            </>
          )}
          {approval?.state === 'usable' && (
            <>
              Your yes is valid until <LocalDate ts={approval.expires_at} /> and was not used yet.
            </>
          )}
        </>
      )}
    </p>
  );
}

function ApprovalBody({
  view,
  viewerId,
  now,
  levels,
  decided,
  problem,
}: RequestViewProps & { view: ApprovalView }) {
  const { request, mission, call, gates } = view;
  const period = periodNow(mission.period_seconds);
  const who = whoOf(view.asker, viewerId);
  return (
    <>
      <RequestStatement
        testId="request-statement"
        verb={
          <>
            <Asking asker={view.asker} viewerId={viewerId} /> on{' '}
            <b>
              <Link href={missionPath(mission.id)}>{mission.name}</Link>
            </b>{' '}
            {REQUEST_WORDS.wantsTo}
          </>
        }
        status={<StateMark request={request} />}
      >
        {/* What the agent wants to do; the permission it needs is two blocks below. */}
        {request.call ? (
          <CallHeadline call={request.call} />
        ) : (
          gates.map((gate) => gate.label).join(' and ')
        )}
      </RequestStatement>
      <ApprovalOutcome view={view} now={now} />
      <Notices view={view} decided={decided} problem={problem} />

      <CallBox
        label={REQUEST_WORDS.exactlySent}
        aside={
          <span data-testid="approval-tool">
            {REQUEST_WORDS.tool} <Mono>{call.tool}</Mono>
          </span>
        }
      >
        {call.arguments_erased ? (
          <p className={styles.erased} data-testid="approval-arguments-erased">
            {REQUEST_WORDS.erased}
          </p>
        ) : (
          <ArgList items={argumentsOf(call.arguments)} testId="approval-arguments" />
        )}
        {call.provider_pages.length > 0 && (
          <p className={styles.erased} data-testid="approval-provider-pages">
            What it brings, at the service:{' '}
            {call.provider_pages.map((page, i) => (
              <span key={page.url}>
                {i > 0 && ' · '}
                <a href={page.url} rel="noreferrer" target="_blank">
                  {page.label}
                </a>
              </span>
            ))}
          </p>
        )}
      </CallBox>

      <FactColumns
        items={[
          {
            label:
              gates.length === 1
                ? REQUEST_WORDS.permissionNeeded
                : `${REQUEST_WORDS.permissionsNeeded} · one answer for the ${gates.length}`,
            testId: 'approval-gated-risks',
            value: gates.map((gate) => (
              <PermissionLine key={gate.risk_id} gate={gate} level={levels[gate.risk_id]} />
            )),
          },
          {
            label:
              request.state === 'open' ? REQUEST_WORDS.roomLeftAfter : REQUEST_WORDS.roomLeftNow,
            testId: 'approval-room',
            value: roomLines(view).map((line) => (
              <RoomAfter
                key={line.risk_id}
                line={line}
                period={period}
                waiting={request.state === 'open'}
              />
            )),
          },
        ]}
      />

      <div className={styles.more}>
        <Disclosure
          id="waiting:call"
          show="Show the fingerprint and what the call touches"
          hide="Hide the fingerprint and what the call touches"
          testId="approval-details"
        >
          <KeyValue
            items={[
              {
                term: 'Fingerprint',
                value: (
                  <span data-testid="approval-fingerprint">
                    <Mono>{call.fingerprint}</Mono>
                  </span>
                ),
              },
              {
                term: 'Touches',
                value: (
                  <span data-testid="approval-slices">
                    {call.slices === null
                      ? 'not recorded'
                      : call.slices.map((slice) => (
                          <span key={slice} className={styles.slice}>
                            <Mono>{slice}</Mono>
                          </span>
                        ))}
                  </span>
                ),
              },
              { term: 'Asked', value: <LocalDate ts={request.created_at} /> },
              ...(request.state === 'open'
                ? [{ term: 'Expires', value: <LocalDate ts={request.expires_at} /> }]
                : []),
            ]}
          />
        </Disclosure>
      </div>

      {view.options.length > 0 && <ApprovalAnswers view={view} />}

      <Context view={view}>
        <AgentSees
          code="approval-required"
          riskId={request.risk_id}
          urlField="approval_url"
          url={request.url}
        />
        <Hint>
          {who.you || !who.holder ? 'Your agent' : `${who.holder}’s agent`} handed out this link;
          only you can answer it. Too many of these?{' '}
          <Link href={missionPath(mission.id)}>
            Set the permission to “{GATE_WORDS.free}” on the mission
          </Link>{' '}
          — its limits stay.
        </Hint>
      </Context>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A limit that was reached
// ─────────────────────────────────────────────────────────────────────────────

function claimChoices(view: ClaimView, now: Date): LimitChoice[] {
  const { risk, period, mission } = view;
  const periodWord = periodNow(mission.period_seconds);
  const untilReset = period.end ? `until the limit resets (${until(period.end, now)})` : 'for good';
  const describe = (option: ClaimOption): React.ReactNode => {
    switch (option.resolution) {
      case 'reset-period':
        return risk
          ? `The ${formatNumber(risk.consumed)} used ${periodWord} go back to zero: ${formatNumber(risk.quota)} more ${period.end ? 'until the reset' : 'in all'}. The limit stays at ${formatNumber(risk.quota)}; the other permissions keep their count.`
          : 'The count of this permission goes back to zero.';
      case 'extend-quota':
        return `That many more calls ${period.end ? 'until the reset' : 'on this mission'} — at most ${formatNumber(option.max_amount ?? 0)}, what was used. The limit itself does not change.`;
      case 'extend-expiry':
        return 'The mission runs until the date you choose. This permission stays at its limit until the reset.';
      case 'refuse':
        return `The agent stays stopped on this permission ${untilReset}; everything else it may do keeps working.`;
    }
  };
  return (
    view.options
      // A mission with no end date has nothing to extend: not an answer for it.
      .filter((option) => option.unavailable?.code !== 'no-expiry')
      .map((option) => ({
        resolution: option.resolution,
        description: describe(option),
        unavailable: option.unavailable
          ? unavailableWords(option.unavailable.code, mission.state, option.unavailable.message)
          : null,
        maxAmount: option.max_amount,
        after: option.after,
      }))
  );
}

/** "3 a day", "50 in all", "50 per period". */
function limitWords(limit: number, periodSeconds: number | null): string {
  const every = everyOf(periodSeconds);
  if (every) return perPeriod(limit, every);
  return periodSeconds === null
    ? `${formatNumber(limit)} in all`
    : `${formatNumber(limit)} per period`;
}

function ClaimOutcome({ view, now }: { view: ClaimView; now: Date }) {
  const { request } = view;
  if (request.state === 'open') return null;
  const when = request.decided_at ? agoSentence(request.decided_at, now) : '';
  const decision = request.decision ?? {};
  const resolution = decision.resolution;
  const amount = typeof decision.amount === 'number' ? decision.amount : null;
  const expiresAt = typeof decision.expires_at === 'string' ? decision.expires_at : null;
  return (
    <p className={styles.outcome} data-testid="claim-outcome">
      {request.state === 'expired' && (
        <>
          Nobody answered before <LocalDate ts={request.expires_at} />: the request expired. The
          permission stays at its limit until the reset.
        </>
      )}
      {request.state === 'refused' && (
        <>You left it {when}: the permission stays at its limit until the reset.</>
      )}
      {request.state === 'granted' && resolution === 'reset-period' && (
        <>
          {ANSWERS['reset-period'].done} {when}.
        </>
      )}
      {request.state === 'granted' && resolution === 'extend-quota' && (
        <>
          You gave back {amount === null ? 'some' : formatNumber(amount)}{' '}
          {amount === 1 ? 'call' : 'calls'} {when}.
        </>
      )}
      {request.state === 'granted' && resolution === 'extend-expiry' && (
        <>
          {ANSWERS['extend-expiry'].done} {when}
          {expiresAt && (
            <>
              , until <LocalDate ts={expiresAt} />
            </>
          )}
          .
        </>
      )}
    </p>
  );
}

const OTHER_COLUMNS: readonly Column<RiskBudgetLine>[] = [
  {
    id: 'permission',
    header: 'Permission',
    cell: (line) => (
      <>
        {line.label}
        <div>
          <Mono quiet href={riskReferencePath(line.risk_id) ?? undefined}>
            {line.risk_id}
          </Mono>
        </div>
      </>
    ),
  },
  { id: 'limit', header: 'Limit', align: 'right', cell: (line) => formatNumber(line.quota) },
  { id: 'used', header: 'Used', align: 'right', cell: (line) => formatNumber(line.consumed) },
  {
    id: 'left',
    header: 'Left',
    align: 'right',
    cell: (line) =>
      line.remaining === 0 ? LIMIT_WORDS.limitReached : formatNumber(line.remaining),
  },
];

function ClaimBody({
  view,
  viewerId,
  now,
  decided,
  problem,
}: RequestViewProps & { view: ClaimView }) {
  const { request, mission, risk, period, asker } = view;
  const periodWord = periodNow(mission.period_seconds);
  const refused = asker?.refused_calls ?? 0;
  return (
    <>
      <RequestStatement
        testId="request-statement"
        verb={
          <>
            <Asking asker={asker} viewerId={viewerId} /> on{' '}
            <b>
              <Link href={missionPath(mission.id)}>{mission.name}</Link>
            </b>{' '}
            {REQUEST_WORDS.reachedALimit}
          </>
        }
        status={<StateMark request={request} />}
      >
        {request.risk_label}
        {risk && (
          <span data-testid="claim-budget">
            {' '}
            · {usedOf(risk.consumed, risk.quota)} {periodWord}
          </span>
        )}
      </RequestStatement>
      <ClaimOutcome view={view} now={now} />
      <Notices view={view} decided={decided} problem={problem} />

      <CallBox
        label={REQUEST_WORDS.stoppedOn}
        aside={
          asker?.tool ? (
            <>
              {REQUEST_WORDS.tool} <Mono>{asker.tool}</Mono>
            </>
          ) : undefined
        }
      >
        <ArgList
          items={[
            { name: 'permission', value: request.risk_id },
            { name: 'since', value: <LocalDate ts={request.created_at} /> },
            {
              name: 'refused',
              value:
                refused === 0
                  ? 'the call that reached the limit; nothing ran'
                  : `${formatNumber(refused)} ${refused === 1 ? 'call' : 'calls'} since; nothing ran`,
            },
          ]}
        />
      </CallBox>

      <FactColumns
        items={[
          {
            label: REQUEST_WORDS.limit,
            testId: 'claim-limit',
            value: risk ? (
              <>
                {limitWords(risk.quota, mission.period_seconds)}
                {period.end ? (
                  <>
                    {' '}
                    · resets <LocalDate ts={period.end} /> ({until(period.end, now)})
                  </>
                ) : (
                  ' · never resets'
                )}
              </>
            ) : (
              'The mission no longer includes this permission.'
            ),
          },
          {
            label: 'Mission',
            value: mission.expires_at ? (
              <>
                ends <LocalDate ts={mission.expires_at} />
              </>
            ) : (
              'no end date'
            ),
          },
        ]}
      />

      {view.options.length > 0 && (
        <section aria-labelledby="your-answer" className={styles.answer}>
          <h3 id="your-answer" className={styles.answerTitle}>
            {REQUEST_WORDS.yourAnswer}
          </h3>
          <LimitAnswer
            requestId={request.id}
            choices={claimChoices(view, now)}
            leaveLabel={period.end ? 'Leave it until the reset' : 'Leave it'}
          />
          <Hint>
            Your answer is written to the activity. Leaving it does not stop the mission. For
            another limit from now on,{' '}
            <Link
              href={`${ROUTES.missions}/${mission.id}?edit=limits#permissions`}
              data-testid="claim-change-limit"
            >
              change the limit
            </Link>{' '}
            on the mission.
          </Hint>
        </section>
      )}

      {view.other_risks.length > 0 && (
        <div className={styles.more}>
          <Disclosure
            id="waiting:other-permissions"
            show={`Show the ${count(view.other_risks.length, TERMS.risk).replace(' ', ' other ')} of the mission`}
            hide="Hide the other permissions"
            testId="claim-other-permissions"
          >
            <DataTable
              caption="The other permissions of the mission, and what is left of each"
              columns={OTHER_COLUMNS}
              rows={view.other_risks}
              rowKey={(line) => line.risk_id}
            />
          </Disclosure>
        </div>
      )}

      <Context view={view}>
        <AgentSees
          code="budget-exhausted"
          riskId={request.risk_id}
          urlField="claim_url"
          url={request.url}
        />
        <Hint>
          The agent was told to hand this link to its human. Only you can answer it; until then,
          every call that needs this permission is refused.
        </Hint>
      </Context>
    </>
  );
}

export function RequestView(props: RequestViewProps) {
  if (props.view.kind === 'permission') {
    const { view } = props;
    return (
      <article className={styles.request} data-testid="request-view" data-kind="permission">
        <RequestStatement
          verb={
            <>
              <Asking asker={view.asker} viewerId={props.viewerId} /> requests permissions on{' '}
              <Link href={missionPath(view.mission.id)}>{view.mission.name}</Link>
            </>
          }
          status={<StateMark request={view.request} />}
        >
          {view.request.call ? <CallHeadline call={view.request.call} /> : 'Missing permissions'}
        </RequestStatement>
        <Notices {...props} view={view} />
        <h3>The agent says</h3>
        <blockquote>{view.reason}</blockquote>
        <ul>
          {view.request.risks.map((r) => (
            <li key={r.risk_id}>
              {r.label} <Mono>{r.risk_id}</Mono>
            </li>
          ))}
        </ul>
        <p>
          This request asks to change the mission for every key. It does not run the refused call.
        </p>
        {view.editor && (
          <PermissionsEditor
            data={view.editor}
            requestId={view.request.id}
            requested={view.request.risks.map((r) => r.risk_id)}
          />
        )}
        {view.request.state === 'open' && (
          <form method="post" action={`/api/requests/${view.request.id}/decide`}>
            <input type="hidden" name="resolution" value="refuse" />
            <Button type="submit">Refuse permission request</Button>
          </form>
        )}
      </article>
    );
  }
  return (
    <article className={styles.request} data-testid="request-view" data-kind={props.view.kind}>
      {props.view.kind === 'claim' ? (
        <ClaimBody {...props} view={props.view} />
      ) : (
        <ApprovalBody {...props} view={props.view} />
      )}
    </article>
  );
}
