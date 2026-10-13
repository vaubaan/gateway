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
 * current period, approval lookup for gated risks, the pure `decide()`, then — on
 * allow — approval consumption, the rate-window push and the counter increments; on
 * refusal, the request drop (or the reuse of the one already open). The event of the
 * call is written in the same transaction. Nothing here touches the audit: the pipeline
 * writes the audit entry from the decision this service returns.
 *
 * The credit an allowed call consumes is never refunded: if the upstream call then
 * fails, the audit keeps `decision: allowed` with `upstream_error` and the counter keeps
 * its increment (spec §3.2 counts allowed calls; see the ADR).
 */

import { refuse, type Refusal } from '@vaubaan/gateway-core';
import type { Iso8601, RiskId, SessionEventKind } from '@vaubaan/shared';
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
import { sessionCounterOf, type BudgetMission } from './mapping.ts';
import { deriveMissionState, type MissionState } from './mission-state.ts';
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
  /** Approvals consumed by this call, one per gated risk. */
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
}

/** What the transaction callback hands back, beyond the store's `allow` / `event`. */
interface TransactionOutcome extends DecisionOutcome {
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
        const decision = decide({
          policy: mission.policy,
          risks_touched: risks,
          counters: ctx.counters,
          rate_windows: this.probeWindows(mission, risks, now),
          period,
          fingerprint,
          approvals: this.lookupApprovals(ctx, mission, risks, fingerprint),
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
    const session = await this.deps.sessions.getByMission(mission.id);
    const counters = session ? await this.deps.sessions.counters(session.id) : [];
    return deriveMissionState(mission, counters.map(sessionCounterOf), now);
  }

  /** Seals the arguments ahead of the transaction when a touched risk may need an
   *  approval request (the encryptor is asynchronous, the transaction is not). */
  private async prepareApprovalArguments(
    input: RecordCallInput,
    risks: readonly RiskId[],
  ): Promise<PreparedArguments | null> {
    const gated = input.mission.policy.some(
      (entry) => entry.gate === 'approval' && risks.includes(entry.risk_id),
    );
    return gated ? this.deps.requests.prepareArguments(input.args ?? {}) : null;
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

  private lookupApprovals(
    ctx: DecideContext,
    mission: BudgetMission,
    risks: readonly RiskId[],
    fingerprint: string,
  ): Map<RiskId, string> {
    const approvals = new Map<RiskId, string>();
    for (const entry of mission.policy) {
      if (entry.gate !== 'approval' || !risks.includes(entry.risk_id)) continue;
      const approval = ctx.findApproval(entry.risk_id, fingerprint);
      if (approval) approvals.set(entry.risk_id, approval.id);
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
    const approvalIds = decision.approvals_to_consume.map(({ risk_id, approval_id }) => {
      const consumed = ctx.consumeApproval(risk_id, fingerprint);
      if (!consumed || consumed.id !== approval_id) {
        // Found a moment ago in this very transaction: anything else is a store bug.
        throw new InvariantError(
          `approval ${approval_id} for '${risk_id}' vanished mid-transaction`,
        );
      }
      return consumed.id;
    });
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
      event: callEvent('call-allowed', input, fingerprint, {
        remaining: decision.remaining,
        approval_ids: approvalIds,
      }),
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
        ...callEvent('call-refused', input, fingerprint, {
          refusal_code: decision.code,
          request_id: request?.id ?? null,
        }),
        riskId: decision.risk_id,
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
    const kind = decision.code === 'budget-exhausted' ? 'claim' : 'approval';
    const existing = ctx.findOpenRequest({ kind, riskId: decision.risk_id, fingerprint });
    if (existing) return existing;
    if (kind === 'approval' && !prepared) {
      throw new InvariantError('approval request without sealed arguments');
    }
    const request = ctx.createRequest({
      kind,
      riskId: decision.risk_id,
      tool: kind === 'approval' ? input.tool : null,
      fingerprint: kind === 'approval' ? fingerprint : null,
      prepared: kind === 'approval' ? prepared : null,
      expiresAt: addSeconds(now, this.deps.requestExpirySeconds),
    });
    ctx.recordEvent({
      kind: 'request' satisfies SessionEventKind,
      riskId: decision.risk_id,
      details: { request_id: request.id, request_kind: kind, tool: input.tool, fingerprint },
    });
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
          risk_id: decision.risk_id,
          fingerprint: decision.details.fingerprint,
          approval_url: this.deps.requestUrl(approvalRequest.id),
          expires_at: approvalRequest.expiresAt,
        });
      }
    }
  }
}

function requireRequest(request: RequestRecord | null, code: string): RequestRecord {
  if (!request) throw new InvariantError(`a '${code}' refusal must carry a request`);
  return request;
}

function addSeconds(instant: Date, seconds: number): Iso8601 {
  return new Date(instant.getTime() + seconds * MS_PER_SECOND).toISOString();
}

function callEvent(
  kind: Extract<SessionEventKind, 'call-allowed' | 'call-refused'>,
  input: RecordCallInput,
  fingerprint: string,
  details: Record<string, unknown>,
): NewEvent {
  return {
    kind,
    details: {
      tool: input.tool,
      fingerprint,
      risk_ids: distinctRisks(input.risks_touched),
      agent_label: input.agent_label ?? null,
      ...details,
    },
  };
}
