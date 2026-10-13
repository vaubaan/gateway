/**
 * SessionService — the store-backed executor of the pure budget decision.
 *
 * Spec §3.3 (the session is born on the first call; the session is the source of
 * truth for the budget), §3.4 / §3.5 (the refusal drops a request into the creator's
 * inbox and carries its URL), §6 ("the budget decision and the decrement are a single
 * operation"). Plan §3.5. ADR atomic-budget-accounting.
 *
 * `recordCall` runs, inside one `BEGIN IMMEDIATE` transaction of the store
 * (`SessionsRepo.decideAndDecrement`): session get-or-create, counter read for the
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
 * The credit an allowed call consumes is never refunded: if the upstream call then
 * fails, the audit keeps `decision: allowed` with `upstream_error` and the counter keeps
 * its increment (spec §3.2 counts allowed calls; see the ADR).
 */

import { refuse, type Refusal } from '@vaubaan/gateway-core';
import type { CallAllowedEventDetails, Iso8601, RiskId, TokenAttribution } from '@vaubaan/shared';
import { InvariantError } from '../store/errors.ts';
import type {
  DecideContext,
  DecisionOutcome,
  NewEvent,
  RequestRecord,
  RequestsRepo,
  SessionsRepo,
} from '../store/index.ts';
import type { PreparedArguments } from '../store/repositories/requests.ts';
import { rateWindowKey, type SlidingWindows } from '../rate-limit/index.ts';
import {
  decide,
  distinctRisks,
  type Allow,
  type BudgetOutcome,
  type RateProbe,
  type Refuse,
} from './decide.ts';
import { fingerprintArguments } from './fingerprint.ts';
import { GATE_EVENT_KINDS, openedGatesOf } from './gates.ts';
import type { BudgetMission } from './mapping.ts';
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
  readonly session_id: string;
  readonly period: CurrentPeriod;
  readonly fingerprint: string;
  /** Distinct risks decremented, in call order. */
  readonly decrements: readonly RiskId[];
  /** Remaining quota per touched risk after the decrement (from the stored counters). */
  readonly remaining: Readonly<Record<RiskId, number>>;
  /** Approvals consumed by this call: one covers every gated risk it lists. */
  readonly approval_ids: readonly string[];
}

export interface RecordCallRefused {
  readonly outcome: 'refused';
  readonly session_id: string;
  readonly period: CurrentPeriod;
  readonly fingerprint: string;
  readonly refusal: Refusal;
  /** The claim or approval request the refusal points to; null for `rate-limited`. */
  readonly request_id: string | null;
}

export type RecordCallResult = RecordCallAllowed | RecordCallRefused;

export interface SessionServiceDeps {
  readonly sessions: Pick<SessionsRepo, 'decideAndDecrement' | 'getByMission' | 'counters'>;
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
}

/** What the transaction callback hands back, beyond the store's `allow` / `event`. */
interface TransactionOutcome extends DecisionOutcome {
  /** Typed here: the store takes any event, this service writes only known shapes. */
  readonly event: NewEvent;
  readonly decision: BudgetOutcome;
  readonly request: RequestRecord | null;
  readonly approvalIds: readonly string[];
}

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  async recordCall(input: RecordCallInput): Promise<RecordCallResult> {
    const { mission, now } = input;
    const risks = distinctRisks(input.risks_touched);
    const period = currentPeriod(mission.period, now);
    const fingerprint = fingerprintArguments(input.args);
    const prepared = await this.prepareApprovalArguments(input, risks);

    const result = await this.deps.sessions.decideAndDecrement(
      { missionId: mission.id, riskIds: risks, periodStart: period.start },
      (ctx): TransactionOutcome => {
        const gated = gatedRisks(mission, risks);
        const openedGates = this.openedGates(ctx, gated, period);
        const decision = decide({
          policy: mission.policy,
          risks_touched: risks,
          counters: ctx.counters,
          rate_windows: this.probeWindows(mission, risks, now),
          period,
          fingerprint,
          approvals: this.lookupApprovals(
            ctx,
            input.tool,
            gated.filter((riskId) => !openedGates.has(riskId)),
            fingerprint,
          ),
          opened_gates: openedGates,
        });
        return decision.kind === 'allow'
          ? this.applyAllow(ctx, input, decision, fingerprint, now)
          : this.applyRefusal(ctx, input, decision, fingerprint, prepared, now);
      },
    );

    const { decision, request, approvalIds } = result.outcome;
    if (decision.kind === 'allow') {
      const remaining: Record<RiskId, number> = {};
      for (const entry of mission.policy) {
        if (result.counters.has(entry.risk_id)) {
          remaining[entry.risk_id] = entry.quota - (result.counters.get(entry.risk_id) ?? 0);
        }
      }
      return {
        outcome: 'allowed',
        session_id: result.session.id,
        period,
        fingerprint,
        decrements: decision.decrements,
        remaining,
        approval_ids: approvalIds,
      };
    }
    return {
      outcome: 'refused',
      session_id: result.session.id,
      period,
      fingerprint,
      refusal: this.refusalOf(decision, request),
      request_id: request?.id ?? null,
    };
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
    return readMissionUsage(this.deps.sessions, mission, now);
  }

  /** Seals the arguments ahead of the transaction when a touched risk may need an
   *  approval request (the encryptor is asynchronous, the transaction is not). */
  private async prepareApprovalArguments(
    input: RecordCallInput,
    risks: readonly RiskId[],
  ): Promise<PreparedArguments | null> {
    const gated = gatedRisks(input.mission, risks).length > 0;
    return gated ? this.deps.requests.prepareArguments(input.args ?? {}) : null;
  }

  /** The gates the creator opened for this period, among the gated risks of the call. */
  private openedGates(
    ctx: DecideContext,
    gated: readonly RiskId[],
    period: CurrentPeriod,
  ): Set<RiskId> {
    if (gated.length === 0) return new Set();
    const events = ctx.riskEvents({ kinds: GATE_EVENT_KINDS, riskIds: gated, since: period.start });
    return openedGatesOf(events, period);
  }

  private probeWindows(
    mission: BudgetMission,
    risks: readonly RiskId[],
    now: Date,
  ): Map<RiskId, RateProbe> {
    const probes = new Map<RiskId, RateProbe>();
    for (const entry of mission.policy) {
      if (!risks.includes(entry.risk_id)) continue;
      const probe = this.deps.rateWindows.peek(
        rateWindowKey(mission.id, entry.risk_id),
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
    decision: Allow,
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
    for (const entry of input.mission.policy) {
      if (!decision.decrements.includes(entry.risk_id)) continue;
      this.deps.rateWindows.push(
        rateWindowKey(input.mission.id, entry.risk_id),
        entry.rate_limit.window_seconds * MS_PER_SECOND,
        now.getTime(),
      );
    }
    return {
      allow: true,
      decision,
      request: null,
      approvalIds,
      event: {
        kind: 'call-allowed',
        details: {
          ...callDetails(input, fingerprint),
          remaining: decision.remaining,
          approval_ids: approvalIds,
        },
      },
    };
  }

  private applyRefusal(
    ctx: DecideContext,
    input: RecordCallInput,
    decision: Refuse,
    fingerprint: string,
    prepared: PreparedArguments | null,
    now: Date,
  ): TransactionOutcome {
    const request = this.requestFor(ctx, input, decision, fingerprint, prepared, now);
    return {
      allow: false,
      decision,
      request,
      approvalIds: [],
      event: {
        kind: 'call-refused',
        riskId: decision.risk_id,
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
    decision: Refuse,
    fingerprint: string,
    prepared: PreparedArguments | null,
    now: Date,
  ): RequestRecord | null {
    if (decision.code === 'rate-limited') return null;
    const expiresAt = addSeconds(now, this.deps.requestExpirySeconds);
    if (decision.code === 'budget-exhausted') {
      const open = ctx.findOpenRequest({ kind: 'claim', riskId: decision.risk_id });
      if (open) return open;
      const claim = ctx.createRequest({ kind: 'claim', riskId: decision.risk_id, expiresAt });
      ctx.recordEvent({
        kind: 'request',
        riskId: decision.risk_id,
        details: { request_id: claim.id, request_kind: 'claim', tool: input.tool, fingerprint },
      } satisfies NewEvent);
      return claim;
    }

    // One request covers the call: every gated risk it touches, not only the first.
    const gatedRisks = decision.details.gated_risks;
    const [firstRisk] = gatedRisks;
    if (firstRisk === undefined) {
      throw new InvariantError('an approval-required refusal names the gated risks of the call');
    }
    const open = ctx.findOpenRequest({
      kind: 'approval',
      tool: input.tool,
      fingerprint,
      riskIds: gatedRisks,
    });
    if (open) return open;
    if (!prepared) throw new InvariantError('approval request without sealed arguments');
    const request = ctx.createRequest({
      kind: 'approval',
      riskId: firstRisk,
      riskIds: gatedRisks,
      tool: input.tool,
      fingerprint,
      prepared,
      expiresAt,
    });
    ctx.recordEvent({
      kind: 'request',
      riskId: firstRisk,
      details: {
        request_id: request.id,
        request_kind: 'approval',
        tool: input.tool,
        fingerprint,
        risk_ids: gatedRisks,
      },
    } satisfies NewEvent);
    return request;
  }

  private refusalOf(decision: Refuse, request: RequestRecord | null): Refusal {
    switch (decision.code) {
      case 'budget-exhausted':
        return refuse.budgetExhausted({
          risk_id: decision.risk_id,
          quota: decision.details.quota,
          consumed: decision.details.consumed,
          period_end: decision.details.period_end,
          claim_url: this.deps.requestUrl(requireRequest(request, decision.code).id),
        });
      case 'rate-limited':
        return refuse.rateLimited({
          risk_id: decision.risk_id,
          limit: decision.details.limit,
          retry_after_seconds: decision.details.retry_after_seconds,
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

/** The touched risks the mission gates `approval`, in policy order. */
function gatedRisks(mission: BudgetMission, risks: readonly RiskId[]): RiskId[] {
  return mission.policy
    .filter((entry) => entry.gate === 'approval' && risks.includes(entry.risk_id))
    .map((entry) => entry.risk_id);
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
  'tool' | 'fingerprint' | 'risk_ids' | 'agent_label' | 'token_id' | 'token_kind' | 'holder'
>;

function callDetails(input: RecordCallInput, fingerprint: string): CallDetails {
  return {
    tool: input.tool,
    fingerprint,
    risk_ids: distinctRisks(input.risks_touched),
    agent_label: input.agent_label ?? null,
    token_id: input.token?.token_id ?? null,
    token_kind: input.token?.token_kind ?? null,
    holder: input.token?.holder ?? null,
  };
}
