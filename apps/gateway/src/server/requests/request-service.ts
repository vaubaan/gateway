/**
 * `RequestService` — what happens to a request after the refusal dropped it
 * (spec §2.3 Request, §3.4, §4.2 "Request inbox", §6 "requests are granted
 * only in a human session", §7.6).
 *
 * The budget's `SessionService.recordCall` inserts the `claim` row inside the
 * refusal transaction and puts `<public_url>/r/<id>` in the refusal; this
 * service owns the rest: the inbox, the creator's view, the decision and its
 * events, the expiry sweep.
 *
 * Access rule, the same everywhere: a request is addressed to the creator of
 * its mission. Any other identity — another user, an owner of the same
 * connection, an operator — gets `forbidden`, and so does an unknown id, so
 * the answer says nothing about what exists.
 *
 * One decide entry point per request kind: `decideClaim` here, the approval
 * decision arrives with P2.1 (`decide()` dispatches and answers
 * `unsupported-kind` meanwhile).
 */
import type { AdminAct } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import {
  parseRiskId,
  type Iso8601,
  type MissionPolicyEntry,
  type RequestKind,
  type RequestStatus,
  type RiskId,
} from '@vaubaan/shared';

import {
  budgetMissionOf,
  currentPeriod,
  deriveMissionState,
  missionUsageReader,
  type BudgetMission,
  type CurrentPeriod,
  type MissionState,
  type SessionService,
} from '../budget';
import type { Logger } from '../logging';
import { enumerateCatalog } from '../missions/catalog-view';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import { NotFoundError } from '../store/errors';
import type { ClaimDecisionContext, ClaimDecisionOutcome } from '../store/repositories/requests';
import type { MissionRecord, RequestRecord } from '../store/types';
import {
  checkClaimDecision,
  claimOptions,
  parseClaimDecision,
  type ClaimDecision,
  type ClaimOption,
  type ClaimProblem,
  type ClaimSituation,
} from './claim';
import { eventLineOf, type SessionEventLine } from './events';
import { effectiveState } from './state';
import { requestUrl } from './url';

/** How many session events the creator's view shows, most recent first. */
export const SESSION_EVENTS_SHOWN = 20;

/** The user behind a request page or a decision: the session's user. */
export interface RequestActor {
  readonly id: string;
}

export interface RequestServiceDeps {
  readonly store: Pick<Store, 'requests' | 'missions' | 'sessions' | 'auditWriter'>;
  /** Risk labels come from the plugins' catalogs, the single provider list. */
  readonly registry: Pick<PluginRegistry, 'get'>;
  /** `InstanceConfig.publicUrl` — the origin of every request URL. */
  readonly publicUrl: URL;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * The budget's "load counters, derive state" read (`SessionService.usageOf`).
   * Defaults to the same read over `store.sessions`, for a module wired before
   * the `SessionService` exists.
   */
  readonly budget?: Pick<SessionService, 'usageOf'>;
}

export interface RequestSummary {
  readonly id: string;
  readonly kind: RequestKind;
  /** As of now: an open request past its expiry reads `expired`. */
  readonly state: RequestStatus;
  readonly risk_id: RiskId;
  readonly risk_label: string;
  readonly created_at: Iso8601;
  readonly expires_at: Iso8601;
  readonly decided_at: Iso8601 | null;
  /** The creator's answer (`resolution`, amounts, dates); `null` while open. */
  readonly decision: Readonly<Record<string, unknown>> | null;
  /** `<public_url>/r/<id>` — the URL the refusal carried. */
  readonly url: string;
  readonly mission: { readonly id: string; readonly name: string };
}

export interface RiskBudgetLine {
  readonly risk_id: RiskId;
  readonly label: string;
  readonly quota: number;
  readonly consumed: number;
  /** Clamped at zero. */
  readonly remaining: number;
}

export interface ClaimView {
  readonly kind: 'claim';
  readonly request: RequestSummary;
  readonly mission: {
    readonly id: string;
    readonly name: string;
    readonly state: MissionState['kind'];
    readonly expires_at: Iso8601 | null;
  };
  readonly period: CurrentPeriod;
  /** The claimed risk; `null` when it left the policy since. */
  readonly risk: RiskBudgetLine | null;
  readonly other_risks: readonly RiskBudgetLine[];
  /** Last events of the mission's session, most recent first. */
  readonly events: readonly SessionEventLine[];
  /** The four actions with their consequence; empty once the request is not open. */
  readonly options: readonly ClaimOption[];
}

/** Approval requests are decided in a later version (P2.1): the view says so, no more. */
export interface ApprovalView {
  readonly kind: 'approval';
  readonly request: RequestSummary;
}

export type RequestView = ClaimView | ApprovalView;

export type ViewResult =
  | { readonly outcome: 'ok'; readonly view: RequestView }
  /** Not the creator, or no such request: one answer. */
  | { readonly outcome: 'forbidden' };

export type DecideResult =
  | { readonly ok: true; readonly request: RequestSummary }
  | { readonly ok: false; readonly reason: 'forbidden' }
  | { readonly ok: false; readonly reason: 'not-open'; readonly state: RequestStatus }
  | { readonly ok: false; readonly reason: 'unsupported-kind'; readonly kind: RequestKind }
  | { readonly ok: false; readonly reason: 'invalid'; readonly problem: ClaimProblem };

/** Thrown inside the decision transaction to roll it back with a reason. */
class ClaimProblemError extends Error {
  constructor(readonly problem: ClaimProblem) {
    super(problem.message);
    this.name = 'ClaimProblemError';
  }
}

interface AppliedClaim extends ClaimDecisionOutcome {
  readonly act: AdminAct;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown>;
}

interface OwnedRequest {
  readonly request: RequestRecord;
  readonly mission: MissionRecord;
}

export class RequestService {
  private readonly labels = new Map<string, ReadonlyMap<RiskId, string>>();

  private readonly budget: Pick<SessionService, 'usageOf'>;

  constructor(private readonly deps: RequestServiceDeps) {
    this.budget = deps.budget ?? missionUsageReader(deps.store.sessions);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reads
  // ───────────────────────────────────────────────────────────────────────────

  /** Open requests awaiting this user as creator, oldest first (spec §4.2). */
  async inbox(user: RequestActor): Promise<RequestSummary[]> {
    const now = this.deps.clock.now();
    const open = await this.deps.store.requests.listOpenForCreator(user.id);
    const names = new Map<string, string>();
    const summaries: RequestSummary[] = [];
    for (const request of open) {
      if (effectiveState(request, now) !== 'open') continue;
      let name = names.get(request.missionId);
      if (name === undefined) {
        name = (await this.deps.store.missions.getById(request.missionId))?.name ?? '';
        names.set(request.missionId, name);
      }
      summaries.push(this.summaryOf(request, { id: request.missionId, name }, now));
    }
    return summaries;
  }

  /** The badge of the "Requests" entry of the application bar. */
  async openCount(user: RequestActor): Promise<number> {
    const now = this.deps.clock.now();
    const open = await this.deps.store.requests.listOpenForCreator(user.id);
    return open.filter((request) => effectiveState(request, now) === 'open').length;
  }

  /** The creator's view of one request. */
  async view(user: RequestActor, requestId: string): Promise<ViewResult> {
    const owned = await this.own(user, requestId);
    if (!owned) return { outcome: 'forbidden' };
    const { request, mission } = owned;
    const now = this.deps.clock.now();
    const summary = this.summaryOf(request, mission, now);
    if (request.kind !== 'claim')
      return { outcome: 'ok', view: { kind: 'approval', request: summary } };

    const budget = budgetMissionOf(mission);
    const { session_id, state, period, consumed } = await this.budget.usageOf(budget, now);
    const lines = budget.policy.map((entry) => this.lineOf(entry, consumed));
    const risk = lines.find((line) => line.risk_id === request.riskId) ?? null;
    const events = session_id
      ? await this.deps.store.sessions.listEvents(session_id, {
          order: 'desc',
          limit: SESSION_EVENTS_SHOWN,
        })
      : [];

    return {
      outcome: 'ok',
      view: {
        kind: 'claim',
        request: summary,
        mission: {
          id: mission.id,
          name: mission.name,
          state: state.kind,
          expires_at: mission.expiresAt,
        },
        period,
        risk,
        other_risks: lines.filter((line) => line.risk_id !== request.riskId),
        events: events.map(eventLineOf),
        options:
          summary.state === 'open'
            ? claimOptions(situationOf(budget, state.kind, period, request.riskId, consumed, now))
            : [],
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Decisions — one entry point per kind
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Decides a request from an untrusted body (JSON or form fields),
   * dispatching on the request's kind.
   */
  async decide(user: RequestActor, requestId: string, raw: unknown): Promise<DecideResult> {
    const owned = await this.own(user, requestId);
    if (!owned) return { ok: false, reason: 'forbidden' };
    switch (owned.request.kind) {
      case 'claim': {
        const parsed = parseClaimDecision(raw);
        if (!parsed.ok) return { ok: false, reason: 'invalid', problem: parsed.problem };
        return this.decideClaim(user, requestId, parsed.decision);
      }
      case 'approval':
        // P2.1 adds `decideApproval` here.
        return { ok: false, reason: 'unsupported-kind', kind: owned.request.kind };
    }
  }

  /**
   * The creator's answer to a claim. The state change, the effect on the
   * counters or on the expiry, and the session event are one transaction of
   * the store; the token does not change and the executor replays its call.
   */
  async decideClaim(
    user: RequestActor,
    requestId: string,
    decision: ClaimDecision,
  ): Promise<DecideResult> {
    const owned = await this.own(user, requestId);
    if (!owned) return { ok: false, reason: 'forbidden' };
    const { mission } = owned;
    if (owned.request.kind !== 'claim') {
      return { ok: false, reason: 'unsupported-kind', kind: owned.request.kind };
    }
    const now = this.deps.clock.now();
    const budget = budgetMissionOf(mission);
    const period = currentPeriod(budget.period, now);
    const missionState = deriveMissionState(budget, [], now).kind;

    let result;
    try {
      result = await this.deps.store.requests.decideClaim(requestId, user.id, (ctx) =>
        applyClaim(ctx, {
          decision,
          user,
          period,
          // The counters are read inside the transaction: the check and the
          // write see the same numbers.
          situation: situationOf(
            budget,
            missionState,
            period,
            ctx.request.riskId,
            ctx.counters(period.start),
            now,
          ),
        }),
      );
    } catch (err) {
      if (err instanceof ClaimProblemError) {
        return { ok: false, reason: 'invalid', problem: err.problem };
      }
      if (err instanceof NotFoundError) return { ok: false, reason: 'forbidden' };
      throw err;
    }
    if (result.status === 'not-open') {
      return { ok: false, reason: 'not-open', state: effectiveState(result.request, now) };
    }

    const { outcome, request } = result;
    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(now),
      user_id: user.id,
      act: outcome.act,
      object: { type: 'request', id: request.id },
      before: outcome.before,
      after: { mission_id: mission.id, risk_id: request.riskId, ...outcome.after },
      delegated_client_id: null,
    });
    this.deps.logger.info('claim decided', {
      request_id: request.id,
      mission_id: mission.id,
      risk_id: request.riskId,
      resolution: decision.resolution,
      user_id: user.id,
    });
    return { ok: true, request: this.summaryOf(request, mission, now) };
  }

  /**
   * Flips every open request past its expiry to `expired` (spec §2.3
   * "unanswered after a configured delay"). A claim that expires changes
   * nothing else: the risk stays exhausted until the next period (§3.4).
   */
  async sweep(): Promise<number> {
    const expired = await this.deps.store.requests.sweepExpired();
    if (expired.length > 0) {
      this.deps.logger.info('requests expired', {
        count: expired.length,
        request_ids: expired.map((request) => request.id),
      });
    }
    return expired.length;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  /** The request and its mission when `user` is the mission's creator; otherwise `null`. */
  private async own(user: RequestActor, requestId: string): Promise<OwnedRequest | null> {
    const request = await this.deps.store.requests.getById(requestId);
    if (!request) return null;
    const mission = await this.deps.store.missions.getById(request.missionId);
    if (!mission || mission.creatorUserId !== user.id) return null;
    return { request, mission };
  }

  private summaryOf(
    request: RequestRecord,
    mission: { readonly id: string; readonly name: string },
    now: Date,
  ): RequestSummary {
    return {
      id: request.id,
      kind: request.kind,
      state: effectiveState(request, now),
      risk_id: request.riskId,
      risk_label: this.labelOf(request.riskId),
      created_at: request.createdAt,
      expires_at: request.expiresAt,
      decided_at: request.decidedAt,
      decision: request.decision,
      url: requestUrl(this.deps.publicUrl, request.id),
      mission: { id: mission.id, name: mission.name },
    };
  }

  private lineOf(entry: MissionPolicyEntry, consumed: ReadonlyMap<RiskId, number>): RiskBudgetLine {
    const used = consumed.get(entry.risk_id) ?? 0;
    return {
      risk_id: entry.risk_id,
      label: this.labelOf(entry.risk_id),
      quota: entry.quota,
      consumed: used,
      remaining: Math.max(0, entry.quota - used),
    };
  }

  /** The catalog label of a risk; its id when the plugin or the entry is gone. */
  private labelOf(riskId: RiskId): string {
    const provider = providerOf(riskId);
    if (!provider) return riskId;
    let labels = this.labels.get(provider);
    if (!labels) {
      const registered = this.deps.registry.get(provider);
      labels = new Map(
        registered
          ? enumerateCatalog(registered.plugin.catalog).map((risk) => [risk.risk_id, risk.label])
          : [],
      );
      this.labels.set(provider, labels);
    }
    return labels.get(riskId) ?? riskId;
  }
}

function providerOf(riskId: RiskId): string | null {
  return parseRiskId(riskId)?.provider ?? null;
}

function situationOf(
  mission: BudgetMission,
  missionState: MissionState['kind'],
  period: CurrentPeriod,
  riskId: RiskId,
  consumed: ReadonlyMap<RiskId, number>,
  now: Date,
): ClaimSituation {
  return {
    now,
    mission_state: missionState,
    expires_at: mission.expires_at,
    period_end: period.end,
    risk_id: riskId,
    quota: mission.policy.find((entry) => entry.risk_id === riskId)?.quota ?? null,
    consumed: consumed.get(riskId) ?? 0,
  };
}

interface ApplyInput {
  readonly decision: ClaimDecision;
  readonly user: RequestActor;
  readonly period: CurrentPeriod;
  readonly situation: ClaimSituation;
}

/** Runs inside the store's transaction: check, effect, event. Synchronous. */
function applyClaim(ctx: ClaimDecisionContext, input: ApplyInput): AppliedClaim {
  const { decision, user, period, situation } = input;
  const problem = checkClaimDecision(situation, decision);
  if (problem) throw new ClaimProblemError(problem);
  const riskId = ctx.request.riskId;
  const base = { request_id: ctx.request.id };
  const span = { period_start: period.start, period_end: period.end };

  switch (decision.resolution) {
    case 'reset-period': {
      const before = ctx.resetCounters(period.start);
      const credits = Object.fromEntries([...before].filter(([, count]) => count > 0));
      ctx.recordEvent({
        kind: 'reset',
        riskId,
        actorUserId: user.id,
        details: { ...base, ...span, credits },
      });
      return {
        state: 'granted',
        decision: { resolution: decision.resolution, ...span, credits },
        act: 'period-reset',
        before: { consumed: credits },
        after: { resolution: decision.resolution, ...span },
      };
    }
    case 'extend-quota': {
      if (!ctx.creditCounter(period.start, riskId, decision.amount)) {
        throw new ClaimProblemError({
          code: 'invalid-amount',
          message: `Fewer than ${decision.amount} actions were consumed on '${riskId}' in the current period.`,
        });
      }
      const credits = { [riskId]: decision.amount };
      ctx.recordEvent({
        kind: 'extension',
        riskId,
        actorUserId: user.id,
        details: { ...base, dimension: 'quota', amount: decision.amount, ...span, credits },
      });
      return {
        state: 'granted',
        decision: { resolution: decision.resolution, amount: decision.amount, ...span },
        act: 'budget-extended',
        before: { consumed: situation.consumed },
        after: {
          resolution: decision.resolution,
          amount: decision.amount,
          consumed: situation.consumed - decision.amount,
          ...span,
        },
      };
    }
    case 'extend-expiry': {
      ctx.setMissionExpiry(decision.expires_at);
      const change = { expires_at_before: situation.expires_at, expires_at: decision.expires_at };
      ctx.recordEvent({
        kind: 'extension',
        riskId,
        actorUserId: user.id,
        details: { ...base, dimension: 'expiry', ...change },
      });
      return {
        state: 'granted',
        decision: { resolution: decision.resolution, ...change },
        act: 'expiry-extended',
        before: { expires_at: situation.expires_at },
        after: { resolution: decision.resolution, expires_at: decision.expires_at },
      };
    }
    case 'refuse': {
      ctx.recordEvent({
        kind: 'request',
        riskId,
        actorUserId: user.id,
        details: { ...base, request_kind: ctx.request.kind, state: 'refused' },
      });
      return {
        state: 'refused',
        decision: { resolution: decision.resolution },
        act: 'request-refused',
        before: null,
        after: { resolution: decision.resolution },
      };
    }
  }
}
