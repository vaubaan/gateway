/**
 * MissionLogService — the store-backed executor of the pure budget decision.
 *
 * Spec §3.3 (the mission log is born on the first call; the mission log is the source of
 * truth for the budget), §3.4 / §3.5 (the refusal drops a request into the creator's
 * inbox and carries its URL), §6 ("the budget decision and the decrement are a single
 * operation"). Plan §3.5. ADR atomic-budget-accounting.
 *
 * `recordCall` runs, inside one `BEGIN IMMEDIATE` transaction of the store
 * (`MissionLogsRepo.decideAndDecrement`): mission log get-or-create, counter read for the
 * current period, the gates the creator opened for the period, approval lookup for
 * the risks still gated, the pure `decide()`, then — on allow — approval consumption,
 * the rate-window push and the counter increments; on refusal, the request drop (or
 * the reuse of the one already open). The event of the call is written in the same
 * transaction. Nothing here touches the audit: the pipeline writes the audit entry
 * from the decision this service returns.
 *
 * An approval and an approval request are bound to the call: the mission, the tool and
 * the canonical fingerprint of the arguments (`ApprovedCall`), and they list the gated
 * risks of that call they cover. The same arguments on another tool are another call.
 * A call that touches several gated risks drops ONE request listing them all, and the
 * approval its grant produces lets the identical replay through (spec §3.5).
 *
 * The limits that decide are the ones stored when the transaction runs, not the ones of
 * the mission the caller loaded: `DecideContext.limits` reads the policy rows of the
 * touched risks inside the transaction, so a limit the creator lowers is in force for
 * the very next decision, whatever was loaded before it (`livePolicy`). The same
 * read refreshes gates and rejects permissions removed since admission.
 *
 * The credit an allowed call consumes is never refunded: if the upstream call then
 * fails, the audit keeps `decision: allowed` with `upstream_error` and the counter keeps
 * its increment (spec §3.2 counts allowed calls; see the ADR).
 */

import { refuse, type Refusal } from '@vaubaan/gateway-core';
import {
  lineKeyOf,
  policyLineKey,
  type CallAllowedEventDetails,
  type Iso8601,
  type MissionPolicy,
  type PolicyLineKey,
  type RiskId,
  type TokenAttribution,
} from '@vaubaan/shared';
import { InvariantError } from '../store/errors.ts';
import type {
  DecideContext,
  DecisionOutcome,
  NewEvent,
  RequestRecord,
  RequestsRepo,
  MissionLogsRepo,
  StoredLimits,
} from '../store/index.ts';
import type { RequestLine } from '../store/types.ts';
import type { NotificationEvents } from '../notifications/events.ts';
import type { PreparedArguments } from '../store/repositories/requests.ts';
import { rateWindowKey, type SlidingWindows } from '../rate-limit/index.ts';
import {
  combineSetDecisions,
  decide,
  distinctRisks,
  type AllowAcrossSets,
  type BudgetOutcomeAcrossSets,
  type RateProbe,
  type RefuseAcrossSets,
} from './decide.ts';
import { BudgetInvariantError } from './errors.ts';
import { fingerprintArguments } from './fingerprint.ts';
import { GATE_EVENT_KINDS, openedGatesOf, openedInSet } from './gates.ts';
import { resourceSetLabelOf, type BudgetMission } from './mapping.ts';
import type { MissionState } from './mission-state.ts';
import { readMissionUsage, type MissionUsage } from './mission-usage.ts';
import { currentPeriod, type CurrentPeriod } from './period.ts';

const MS_PER_SECOND = 1000;

export interface RecordCallInput {
  readonly mission: BudgetMission;
  readonly tool: string;
  /** Call arguments: fingerprinted here, sealed for an approval request when needed. */
  readonly args: unknown;
  readonly risks_touched: readonly RiskId[];
  /**
   * The resource sets the risk stage judged the call against (risk model §4.7): every
   * touched risk is checked and charged in each. Absent (a caller outside the
   * pipeline): every set whose policy names a touched risk. Empty: a broken risk stage,
   * refused.
   */
  readonly resource_set_ids?: readonly string[];
  /** Free-form attribution; recorded on the event, no effect on the decision. */
  readonly agent_label?: string | null;
  /**
   * The token the call presented and its holder (spec §8). Recorded on the event; no
   * effect on the decision: every token of a mission draws from the same counters
   * (spec §3.2 "one budget per mission, however many agents or tokens").
   */
  readonly token?: TokenAttribution | null;
  readonly now: Date;
}

export interface RecordCallAllowed {
  readonly outcome: 'allowed';
  readonly mission_log_id: string;
  readonly period: CurrentPeriod;
  readonly fingerprint: string;
  /** Distinct risks decremented, in call order (in each set charged). */
  readonly decrements: readonly RiskId[];
  /** The sets charged. */
  readonly resource_set_ids: readonly string[];
  /**
   * Remaining quota per touched risk after the decrement (from the stored counters): the
   * least left among the sets charged.
   */
  readonly remaining: Readonly<Record<RiskId, number>>;
  /** Approvals consumed by this call: one covers every gated risk it lists. */
  readonly approval_ids: readonly string[];
}

export interface RecordCallRefused {
  readonly outcome: 'refused';
  readonly mission_log_id: string;
  readonly period: CurrentPeriod;
  readonly fingerprint: string;
  readonly refusal: Refusal;
  /** The claim or approval request the refusal points to; null for `rate-limited`. */
  readonly request_id: string | null;
}

export type RecordCallResult = RecordCallAllowed | RecordCallRefused;

export interface MissionLogServiceDeps {
  readonly missionLogs: Pick<MissionLogsRepo, 'decideAndDecrement' | 'getByMission' | 'counters'>;
  readonly requests: Pick<RequestsRepo, 'prepareArguments'>;
  readonly rateWindows: SlidingWindows;
  /** `<public_url>/r/<request_id>` — built by the composition root from the configuration. */
  readonly requestUrl: (requestId: string) => string;
  /** Lifetime of a claim or approval request (`requests.expiry` in the configuration). */
  readonly requestExpirySeconds: number;
  /**
   * How long a granted approval stays usable (`approvals.expiry` in the configuration).
   * Only told to the executor here, in the `approval-required` refusal; the request
   * service applies it when the creator grants.
   */
  readonly approvalValiditySeconds: number;
  /**
   * Told of a claim or an approval request this service opened, after the transaction
   * committed and without waiting (spec §4.2 bis); never told of one already open.
   */
  readonly notifications?: Pick<NotificationEvents, 'requestOpened'>;
}

/** The request a refusal points to, and whether this call opened it. */
interface AskedRequest {
  readonly record: RequestRecord;
  readonly opened: boolean;
}

/** A preflight that found the limits clear: nothing written. */
interface PreflightPass extends DecisionOutcome {
  readonly pass: true;
}

/** What the transaction callback hands back, beyond the store's `allow` / `event`. */
interface TransactionOutcome extends DecisionOutcome {
  /** Typed here: the store takes any event, this service writes only known shapes. */
  readonly event: NewEvent;
  readonly decision: BudgetOutcomeAcrossSets;
  readonly request: RequestRecord | null;
  /** The request was created by this call, not found open. */
  readonly opened: boolean;
  readonly approvalIds: readonly string[];
  /** The policy the decision was taken with: the caller's, with the limits read now. */
  readonly policy: MissionPolicy;
}

export class MissionLogService {
  constructor(private readonly deps: MissionLogServiceDeps) {}

  async recordCall(input: RecordCallInput): Promise<RecordCallResult> {
    const { mission, now } = input;
    const risks = distinctRisks(input.risks_touched);
    const sets = setsOf(input);
    const period = currentPeriod(mission.period, now);
    const fingerprint = fingerprintArguments(input.args);
    const prepared = await this.prepareApprovalArguments(input, risks);

    const result = await this.deps.missionLogs.decideAndDecrement(
      { missionId: mission.id, lines: linesOf(sets, risks), periodStart: period.start },
      (ctx): TransactionOutcome => {
        const live: BudgetMission = {
          ...mission,
          policy: livePolicy(mission.policy, ctx.limits, linesOf(sets, risks)),
        };
        const decision = this.decideSets(ctx, input, live, sets, risks, period, fingerprint);
        const decided = { ...input, mission: live };
        return decision.kind === 'allow'
          ? this.applyAllow(ctx, decided, decision, fingerprint, now)
          : this.applyRefusal(ctx, decided, decision, fingerprint, prepared, now);
      },
    );

    const { decision, request, approvalIds, policy } = result.outcome;
    this.notifyOpened(result.outcome, mission.id, input.tool);
    if (decision.kind === 'allow') {
      return {
        outcome: 'allowed',
        mission_log_id: result.missionLog.id,
        period,
        fingerprint,
        decrements: risks,
        resource_set_ids: sets,
        remaining: leastRemaining(policy, result.counters, sets, risks),
        approval_ids: approvalIds,
      };
    }
    return {
      outcome: 'refused',
      mission_log_id: result.missionLog.id,
      period,
      fingerprint,
      refusal: this.refusalOf(mission, decision, request),
      request_id: request?.id ?? null,
    };
  }

  /**
   * The decision of each candidate set over its own lines, counters, rate windows and
   * opened gates, combined (`combineSetDecisions`). In-transaction, pure apart from the
   * reads of `ctx`.
   */
  private decideSets(
    ctx: DecideContext,
    input: RecordCallInput,
    live: BudgetMission,
    sets: readonly string[],
    risks: readonly RiskId[],
    period: CurrentPeriod,
    fingerprint: string,
  ): BudgetOutcomeAcrossSets {
    const gated = live.policy.filter(
      (entry) =>
        entry.gate === 'approval' &&
        sets.includes(entry.resource_set_id ?? '') &&
        risks.includes(entry.risk_id),
    );
    const opened = this.openedGates(ctx, distinctRisks(gated.map((e) => e.risk_id)), period);
    const needed = distinctRisks(
      gated.filter((entry) => !opened.has(lineKeyOf(entry))).map((entry) => entry.risk_id),
    );
    const approvals = this.lookupApprovals(ctx, input.tool, needed, fingerprint);
    return combineSetDecisions(
      sets.map((resourceSetId) => {
        const policy = live.policy.filter((entry) => entry.resource_set_id === resourceSetId);
        return {
          resource_set_id: resourceSetId,
          outcome: decide({
            policy,
            risks_touched: risks,
            counters: countersOfSet(ctx.counters, resourceSetId, risks),
            rate_windows: this.probeWindows(live.id, resourceSetId, policy, risks, input.now),
            period,
            fingerprint,
            approvals,
            opened_gates: openedInSet(opened, resourceSetId),
          }),
        };
      }),
    );
  }

  /**
   * Would the call be refused for its limits — `budget-exhausted` or
   * `rate-limited` — whatever its approvals? Nothing is counted. A limit
   * refusal is recorded exactly as `recordCall` records it (the refused event,
   * the claim request); any other outcome writes nothing and answers `null`.
   * The git door asks it before a push's pack leaves for the service: a push
   * its limits refuse costs no upload. The authoritative decision stays
   * `recordCall`'s.
   */
  async preflightLimits(input: RecordCallInput): Promise<Refusal | null> {
    const { mission, now } = input;
    const risks = distinctRisks(input.risks_touched);
    const sets = setsOf(input);
    const period = currentPeriod(mission.period, now);
    const fingerprint = fingerprintArguments(input.args);
    const result = await this.deps.missionLogs.decideAndDecrement(
      { missionId: mission.id, lines: linesOf(sets, risks), periodStart: period.start },
      (ctx): TransactionOutcome | PreflightPass => {
        const live: BudgetMission = {
          ...mission,
          policy: livePolicy(mission.policy, ctx.limits, linesOf(sets, risks)),
        };
        const decision = combineSetDecisions(
          sets.map((resourceSetId) => {
            const policy = live.policy.filter((entry) => entry.resource_set_id === resourceSetId);
            return {
              resource_set_id: resourceSetId,
              outcome: decide({
                policy,
                risks_touched: risks,
                counters: countersOfSet(ctx.counters, resourceSetId, risks),
                rate_windows: this.probeWindows(live.id, resourceSetId, policy, risks, now),
                period,
                fingerprint,
                // Approvals are not this question: only the limits are.
                approvals: new Map(),
                opened_gates: new Set(risks),
              }),
            };
          }),
        );
        if (
          decision.kind === 'refuse' &&
          (decision.code === 'budget-exhausted' || decision.code === 'rate-limited')
        ) {
          return this.applyRefusal(
            ctx,
            { ...input, mission: live },
            decision,
            fingerprint,
            null,
            now,
          );
        }
        return { allow: false, event: null, pass: true };
      },
    );
    const outcome = result.outcome;
    if ('pass' in outcome) return null;
    this.notifyOpened(outcome, mission.id, input.tool);
    const { decision, request } = outcome;
    return decision.kind === 'allow' ? null : this.refusalOf(mission, decision, request);
  }

  /** Mission state with the rollover applied on read (spec §2.3, §3.3). */
  async stateOf(mission: BudgetMission, now: Date): Promise<MissionState> {
    return (await this.usageOf(mission, now)).state;
  }

  /**
   * The current period of a mission, what it consumed in it and the state that follows.
   * The single "load counters, derive state" read; only the current period is loaded.
   */
  async usageOf(mission: BudgetMission, now: Date): Promise<MissionUsage> {
    return readMissionUsage(this.deps.missionLogs, mission, now);
  }

  /** Seals the arguments ahead of the transaction when a touched risk may need an
   *  approval request (the encryptor is asynchronous, the transaction is not). */
  private async prepareApprovalArguments(
    input: RecordCallInput,
    risks: readonly RiskId[],
  ): Promise<PreparedArguments | null> {
    // A gate can change while encryption awaits; prepare for the policy read in the transaction.
    return risks.length > 0 ? this.deps.requests.prepareArguments(input.args ?? {}) : null;
  }

  /** The lines the creator opened for this period, among the gated risks of the call. */
  private openedGates(
    ctx: DecideContext,
    gated: readonly RiskId[],
    period: CurrentPeriod,
  ): Set<PolicyLineKey> {
    if (gated.length === 0) return new Set();
    const events = ctx.riskEvents({ kinds: GATE_EVENT_KINDS, riskIds: gated, since: period.start });
    return openedGatesOf(events, period);
  }

  /** The rate windows of one set's lines among the touched risks. */
  private probeWindows(
    missionId: string,
    resourceSetId: string,
    policy: MissionPolicy,
    risks: readonly RiskId[],
    now: Date,
  ): Map<RiskId, RateProbe> {
    const probes = new Map<RiskId, RateProbe>();
    for (const entry of policy) {
      if (!risks.includes(entry.risk_id)) continue;
      const probe = this.deps.rateWindows.peek(
        rateWindowKey(missionId, resourceSetId, entry.risk_id),
        entry.rate_limit.window_seconds * MS_PER_SECOND,
        now.getTime(),
      );
      probes.set(entry.risk_id, {
        count: probe.count,
        retry_after_seconds: Math.ceil(probe.retryAfterMs / MS_PER_SECOND),
      });
    }
    return probes;
  }

  /**
   * Which usable approval of this call covers each risk that needs one. An approval
   * that covers them all is preferred — it is the one a request "covering the call"
   * produced —, so one grant is consumed by one replay; otherwise each risk takes the
   * soonest-expiring approval that lists it (approvals granted risk by risk before a
   * request covered the call).
   */
  private lookupApprovals(
    ctx: DecideContext,
    tool: string,
    needed: readonly RiskId[],
    fingerprint: string,
  ): Map<RiskId, string> {
    const approvals = new Map<RiskId, string>();
    if (needed.length === 0) return approvals;
    const usable = ctx.findApprovals({ tool, fingerprint });
    const whole = usable.find((approval) => needed.every((r) => approval.riskIds.includes(r)));
    for (const riskId of needed) {
      const approval = whole ?? usable.find((candidate) => candidate.riskIds.includes(riskId));
      if (approval) approvals.set(riskId, approval.id);
    }
    return approvals;
  }

  private applyAllow(
    ctx: DecideContext,
    input: RecordCallInput,
    decision: AllowAcrossSets,
    fingerprint: string,
    now: Date,
  ): TransactionOutcome {
    // One approval may stand under several risks: it is consumed once.
    const approvalIds = [...new Set(decision.approvals_to_consume.map((a) => a.approval_id))];
    for (const approvalId of approvalIds) {
      if (!ctx.consumeApproval(approvalId)) {
        // Found a moment ago in this very transaction: anything else is a store bug.
        throw new InvariantError(`approval ${approvalId} vanished mid-transaction`);
      }
    }
    const charged = new Set(
      decision.decrements.map((line) => policyLineKey(line.resource_set_id, line.risk_id)),
    );
    for (const entry of input.mission.policy) {
      if (!charged.has(lineKeyOf(entry))) continue;
      this.deps.rateWindows.push(
        rateWindowKey(input.mission.id, entry.resource_set_id ?? '', entry.risk_id),
        entry.rate_limit.window_seconds * MS_PER_SECOND,
        now.getTime(),
      );
    }
    return {
      allow: true,
      decision,
      request: null,
      opened: false,
      approvalIds,
      policy: input.mission.policy,
      event: {
        kind: 'call-allowed',
        details: {
          ...callDetails(input, fingerprint),
          remaining: leastOfLines(decision.remaining, setsOf(input), input.risks_touched),
          approval_ids: approvalIds,
        },
      },
    };
  }

  private applyRefusal(
    ctx: DecideContext,
    input: RecordCallInput,
    decision: RefuseAcrossSets,
    fingerprint: string,
    prepared: PreparedArguments | null,
    now: Date,
  ): TransactionOutcome {
    const asked = this.requestFor(ctx, input, decision, fingerprint, prepared, now);
    const request = asked?.record ?? null;
    return {
      allow: false,
      decision,
      request,
      opened: asked?.opened ?? false,
      approvalIds: [],
      policy: input.mission.policy,
      event: {
        kind: 'call-refused',
        riskId: decision.risk_id,
        resourceSetId: decision.resource_set_id,
        details: {
          ...callDetails(input, fingerprint),
          refusal_code: decision.code,
          request_id: request?.id ?? null,
        },
      },
    };
  }

  /** The request a refusal points to: the one already open for the same ask, or a
   *  new one. `rate-limited` asks nothing of the creator. */
  private requestFor(
    ctx: DecideContext,
    input: RecordCallInput,
    decision: RefuseAcrossSets,
    fingerprint: string,
    prepared: PreparedArguments | null,
    now: Date,
  ): AskedRequest | null {
    if (decision.code === 'rate-limited') return null;
    const expiresAt = addSeconds(now, this.deps.requestExpirySeconds);
    if (decision.code === 'budget-exhausted') {
      // A claim is about one line: the risk in the set whose budget is spent.
      const line: RequestLine = {
        resourceSetId: decision.resource_set_id,
        riskId: decision.risk_id,
      };
      const open = ctx.findOpenRequest({ kind: 'claim', line });
      if (open) return { record: open, opened: false };
      const claim = ctx.createRequest({
        kind: 'claim',
        riskId: decision.risk_id,
        lines: [line],
        expiresAt,
      });
      ctx.recordEvent({
        kind: 'request',
        riskId: decision.risk_id,
        resourceSetId: decision.resource_set_id,
        details: { request_id: claim.id, request_kind: 'claim', tool: input.tool, fingerprint },
      } satisfies NewEvent);
      return { record: claim, opened: true };
    }

    // One request covers the call: every gated risk it touches, not only the first.
    const gatedRisks = decision.details.gated_risks;
    const [firstRisk] = gatedRisks;
    if (firstRisk === undefined) {
      throw new InvariantError('an approval-required refusal names the gated risks of the call');
    }
    // Every gated line of every set the call was judged against (risk model §4.7).
    const lines: RequestLine[] = decision.gated_lines.map((line) => ({
      resourceSetId: line.resource_set_id,
      riskId: line.risk_id,
    }));
    const open = ctx.findOpenRequest({ kind: 'approval', tool: input.tool, fingerprint, lines });
    if (open) return { record: open, opened: false };
    if (!prepared) throw new InvariantError('approval request without sealed arguments');
    const request = ctx.createRequest({
      kind: 'approval',
      riskId: firstRisk,
      riskIds: gatedRisks,
      lines,
      tool: input.tool,
      fingerprint,
      prepared,
      expiresAt,
    });
    ctx.recordEvent({
      kind: 'request',
      riskId: firstRisk,
      resourceSetId: lines[0]?.resourceSetId ?? null,
      details: {
        request_id: request.id,
        request_kind: 'approval',
        tool: input.tool,
        fingerprint,
        risk_ids: gatedRisks,
      },
    } satisfies NewEvent);
    return { record: request, opened: true };
  }

  /** After commit: the creator hears of a request this call opened; nothing is awaited. */
  private notifyOpened(
    outcome: Pick<TransactionOutcome, 'request' | 'opened'>,
    missionId: string,
    tool: string,
  ): void {
    if (!outcome.opened || outcome.request === null) return;
    this.deps.notifications?.requestOpened({
      requestId: outcome.request.id,
      missionId,
      request: outcome.request.kind,
      tool,
    });
  }

  private refusalOf(
    mission: BudgetMission,
    decision: RefuseAcrossSets,
    request: RequestRecord | null,
  ): Refusal {
    const label = resourceSetLabelOf(mission.resource_sets, decision.resource_set_id);
    const where = label === null ? {} : { resource_set: label };
    switch (decision.code) {
      case 'budget-exhausted':
        return refuse.budgetExhausted({
          risk_id: decision.risk_id,
          quota: decision.details.quota,
          consumed: decision.details.consumed,
          period_end: decision.details.period_end,
          claim_url: this.deps.requestUrl(requireRequest(request, decision.code).id),
          ...where,
        });
      case 'rate-limited':
        return refuse.rateLimited({
          risk_id: decision.risk_id,
          limit: decision.details.limit,
          retry_after_seconds: decision.details.retry_after_seconds,
          ...where,
        });
      case 'approval-required': {
        const approvalRequest = requireRequest(request, decision.code);
        return refuse.approvalRequired({
          // What the request covers, which is what the creator will be asked about.
          risk_id: approvalRequest.riskId,
          risk_ids: approvalRequest.riskIds,
          fingerprint: decision.details.fingerprint,
          approval_url: this.deps.requestUrl(approvalRequest.id),
          expires_at: approvalRequest.expiresAt,
          approval_valid_seconds: this.deps.approvalValiditySeconds,
        });
      }
    }
  }
}

/**
 * Reread the quota, rate and gate of the touched lines inside the decision transaction.
 * A touched line that was removed is dropped, so the decision fails closed instead of
 * executing with stale authority. Untouched lines stay available to the caller.
 */
export function livePolicy(
  policy: MissionPolicy,
  limits: ReadonlyMap<PolicyLineKey, StoredLimits>,
  touched: readonly RequestLine[] = [],
): MissionPolicy {
  const touchedKeys = new Set(touched.map((l) => policyLineKey(l.resourceSetId, l.riskId)));
  return policy
    .filter((entry) => !touchedKeys.has(lineKeyOf(entry)) || limits.has(lineKeyOf(entry)))
    .map((entry) => {
      const stored = limits.get(lineKeyOf(entry));
      if (!stored) return entry;
      return {
        ...entry,
        gate: stored.gate ?? entry.gate,
        quota: stored.quota,
        rate_limit: { max: stored.rateLimit, window_seconds: stored.rateWindowSeconds },
      };
    });
}

/** The distinct candidate sets of a call; a call judged against none is a broken risk stage. */
function setsOf(
  input: Pick<RecordCallInput, 'resource_set_ids' | 'mission' | 'risks_touched'>,
): string[] {
  const named =
    input.resource_set_ids ??
    input.mission.policy
      .filter((entry) => input.risks_touched.includes(entry.risk_id))
      .map((entry) => entry.resource_set_id ?? '');
  const sets = [...new Set(named)];
  if (sets.length === 0) {
    throw new BudgetInvariantError(
      'a call reached the budget without the resource sets it was judged against',
    );
  }
  return sets;
}

/** Each touched risk in each set: the lines a call is charged on. */
function linesOf(sets: readonly string[], risks: readonly RiskId[]): RequestLine[] {
  return sets.flatMap((resourceSetId) => risks.map((riskId) => ({ resourceSetId, riskId })));
}

/** One set's consumed counts, by risk, as `decide()` reads them. */
function countersOfSet(
  counters: ReadonlyMap<PolicyLineKey, number>,
  resourceSetId: string,
  risks: readonly RiskId[],
): Map<RiskId, number> {
  return new Map(
    risks.map((riskId) => [riskId, counters.get(policyLineKey(resourceSetId, riskId)) ?? 0]),
  );
}

/** Per risk, the least of the values of its lines in the sets. */
function leastOfLines(
  values: Readonly<Record<PolicyLineKey, number>>,
  sets: readonly string[],
  risks: readonly RiskId[],
): Record<RiskId, number> {
  const least: Record<RiskId, number> = {};
  for (const riskId of distinctRisks(risks)) {
    const found = sets
      .map((set) => values[policyLineKey(set, riskId)])
      .filter((v): v is number => v !== undefined);
    if (found.length > 0) least[riskId] = Math.min(...found);
  }
  return least;
}

/** Remaining quota per touched risk after the call: the least left among the sets charged. */
function leastRemaining(
  policy: MissionPolicy,
  counters: ReadonlyMap<PolicyLineKey, number>,
  sets: readonly string[],
  risks: readonly RiskId[],
): Record<RiskId, number> {
  const left: Record<PolicyLineKey, number> = {};
  for (const entry of policy) {
    const key = lineKeyOf(entry);
    if (counters.has(key)) left[key] = entry.quota - (counters.get(key) ?? 0);
  }
  return leastOfLines(left, sets, risks);
}

function requireRequest(request: RequestRecord | null, code: string): RequestRecord {
  if (!request) throw new InvariantError(`a '${code}' refusal must carry a request`);
  return request;
}

function addSeconds(instant: Date, seconds: number): Iso8601 {
  return new Date(instant.getTime() + seconds * MS_PER_SECOND).toISOString();
}

/** What a call event carries whether the call is allowed or refused. */
type CallDetails = Pick<
  CallAllowedEventDetails,
  | 'tool'
  | 'fingerprint'
  | 'risk_ids'
  | 'resource_set_ids'
  | 'agent_label'
  | 'token_id'
  | 'token_kind'
  | 'holder'
>;

function callDetails(input: RecordCallInput, fingerprint: string): CallDetails {
  return {
    tool: input.tool,
    fingerprint,
    risk_ids: distinctRisks(input.risks_touched),
    resource_set_ids: setsOf(input),
    agent_label: input.agent_label ?? null,
    token_id: input.token?.token_id ?? null,
    token_kind: input.token?.token_kind ?? null,
    holder: input.token?.holder ?? null,
  };
}
