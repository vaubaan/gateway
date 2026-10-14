/**
 * `RequestService` — what happens to a request after the refusal dropped it
 * (spec §2.3 Request, §3.4, §3.5, §4.2 "Request inbox", §6 "requests are
 * granted only in a human session", §7.6, §7.7).
 *
 * The budget's `SessionService.recordCall` inserts the row — a `claim`, or an
 * `approval` request with the call's arguments sealed — inside the refusal
 * transaction and puts `<public_url>/r/<id>` in the refusal; this service
 * owns the rest: the inbox, the creator's view, the decision and its events,
 * the expiry sweep.
 *
 * Access rule, the same everywhere: a request is addressed to the creator of
 * its mission. Any other identity — another user, an owner of the same
 * connection, an operator — gets `forbidden`, and so does an unknown id, so
 * the answer says nothing about what exists. The arguments of an approval
 * request are opened in one place, `view()`, after that check and only while
 * the request is open: the creator is the only reader they ever have.
 *
 * One decide entry point per request kind: `decideClaim` and
 * `decideApproval`; `decide()` dispatches on the kind of the request.
 */
import type { AdminAct } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import { serializeSlice } from '@vaubaan/policy-engine';
import {
  parseRiskId,
  type Gate,
  type Iso8601,
  type MissionPolicyEntry,
  type MissionTokenKind,
  type RequestKind,
  type RequestStatus,
  type RiskId,
} from '@vaubaan/shared';

import {
  budgetMissionOf,
  currentPeriod,
  deriveMissionState,
  effectiveGate,
  GATE_EVENT_KINDS,
  missionUsageReader,
  openedGatesOf,
  type BudgetMission,
  type CurrentPeriod,
  type MissionState,
  type SessionService,
} from '../budget';
import type { MissionGrounds } from '../authority';
import type { Logger } from '../logging';
import { enumerateCatalog } from '../missions/catalog-view';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import { InvariantError, NotFoundError } from '../store/errors';
import type {
  ApprovalDecisionContext,
  ClaimDecisionContext,
  ClaimDecisionOutcome,
  RequestDecisionOutcome,
  StoredMissionFacts,
} from '../store/repositories/requests';
import type { EventRecord, MissionRecord, RequestRecord } from '../store/types';
import {
  type ApprovalDecision,
  type ApprovalOption,
  approvalOptions,
  type ApprovalProblem,
  type ApprovalSituation,
  checkApprovalDecision,
  closedGates,
  parseApprovalDecision,
} from './approval';
import {
  checkClaimDecision,
  claimOptions,
  parseClaimDecision,
  type ClaimDecision,
  type ClaimOption,
  type ClaimProblem,
  type ClaimSituation,
} from './claim';
import { toolTitleOf } from '../providers/tool-titles';
import { askedBy, REFUSED_CALL_KIND } from './asker';
import { eventLineOf, type SessionEventLine } from './events';
import { effectiveState } from './state';
import { requestUrl } from './url';

/** How many session events the creator's view shows, most recent first. */
export const SESSION_EVENTS_SHOWN = 20;

/** The user behind a request page or a decision: the session's user. */
export interface RequestActor {
  readonly id: string;
}

const MS_PER_SECOND = 1000;

export interface RequestServiceDeps {
  readonly store: Pick<
    Store,
    'requests' | 'missions' | 'sessions' | 'approvals' | 'audit' | 'auditWriter' | 'users'
  >;
  /** Derives `orphaned` on every mission read (handbook authority). */
  readonly grounds: Pick<MissionGrounds, 'derive'>;
  /** `approvals.expiry` of the configuration: how long a granted approval stays usable. */
  readonly approvalValiditySeconds: number;
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
  /** The claimed risk; for an approval request, the first of `risks`. */
  readonly risk_id: RiskId;
  readonly risk_label: string;
  /**
   * Every risk the request is about: the one risk of a claim, every gated risk of the
   * call for an approval request (spec §3.5 "one request covers the call").
   */
  readonly risks: readonly { readonly risk_id: RiskId; readonly label: string }[];
  readonly created_at: Iso8601;
  readonly expires_at: Iso8601;
  readonly decided_at: Iso8601 | null;
  /** The creator's answer (`resolution`, amounts, dates); `null` while open. */
  readonly decision: Readonly<Record<string, unknown>> | null;
  /** `<public_url>/r/<id>` — the URL the refusal carried. */
  readonly url: string;
  readonly mission: { readonly id: string; readonly name: string };
  /** Approval requests: the tool of the call. Never its arguments. */
  readonly tool: string | null;
  /**
   * Approval requests: what the agent wants to do, as a page heads it — the
   * tool, its title when the plugin gives one, and the resource the call
   * resolved to. `null` for a claim. Never the arguments.
   */
  readonly call: RequestCall | null;
}

/** The call of an approval request, from what the gateway already knows of it. */
export interface RequestCall {
  readonly tool: string;
  /** `ProviderPlugin.toolTitles`: "Merge a pull request"; `null` when the plugin gives none. */
  readonly title: string | null;
  /**
   * The resource the refused call resolved to, as the audit recorded it
   * (`resource_ref`: `acme-org/app`); `null` when the call names none, when the
   * entry is gone, and on the reads that do not look it up (a list of answered
   * requests, the answer to a decision).
   */
  readonly resource: string | null;
}

export interface RiskBudgetLine {
  readonly risk_id: RiskId;
  readonly label: string;
  readonly quota: number;
  readonly consumed: number;
  /** Clamped at zero. */
  readonly remaining: number;
}

/**
 * Who asked (spec §8): the holder of the token the refused call presented —
 * authenticated — and the label the agent gave itself — a claim. Read from the
 * session's `call-refused` events (`asker.ts`); the holder is named for a page.
 */
export interface RequestAsker {
  /** `null` on a call recorded before tokens had a holder. */
  readonly token_kind: MissionTokenKind | null;
  /** The member's user id; `null` for a named token, and when the holder is unknown. */
  readonly user_id: string | null;
  /**
   * A member's display name, else their email, else their id; a named token's
   * name; `null` when the event names no holder.
   */
  readonly holder: string | null;
  readonly agent_label: string | null;
  /** The tool of the refused call (a claim's row does not keep it). */
  readonly tool: string | null;
  /** Calls refused with this request in their refusal, the first one included. */
  readonly refused_calls: number;
}

/** The mission of a request, as its creator's view names it. */
export interface RequestMissionView {
  readonly id: string;
  readonly name: string;
  readonly state: MissionState['kind'];
  readonly expires_at: Iso8601 | null;
  /** Length of a period of the mission's limits, in seconds; `null` for a one-off mission. */
  readonly period_seconds: number | null;
}

/**
 * One line of "Waiting for you" (the home and the inbox): the request, who asked,
 * and what is left of each permission it is about in the mission's current period.
 * Never the arguments of the call: those are read on the request's own page.
 */
export interface WaitingItem {
  readonly request: RequestSummary;
  /** `null` when no event of the session points to the request any more. */
  readonly asker: RequestAsker | null;
  /** One line per risk of the request still in the mission's policy, in the request's order. */
  readonly budget: readonly RiskBudgetLine[];
  readonly period: CurrentPeriod;
  /** `null` for a one-off mission: its limits do not reset. */
  readonly period_seconds: number | null;
}

export interface ClaimView {
  readonly kind: 'claim';
  readonly request: RequestSummary;
  readonly mission: RequestMissionView;
  /** Who asked; `null` when the session holds no trace of the refused call. */
  readonly asker: RequestAsker | null;
  readonly period: CurrentPeriod;
  /** The claimed risk; `null` when it left the policy since. */
  readonly risk: RiskBudgetLine | null;
  readonly other_risks: readonly RiskBudgetLine[];
  /** Last events of the mission's session, most recent first. */
  readonly events: readonly SessionEventLine[];
  /** The four actions with their consequence; empty once the request is not open. */
  readonly options: readonly ClaimOption[];
}

/** A risk the call of an approval request touches, with its budget and its gate now. */
export interface TouchedRiskLine extends RiskBudgetLine {
  /** `approval` when a call touching the risk asks the creator now; `auto` otherwise. */
  readonly gate: Gate;
}

/** The precise action an approval request asks about (spec §3.5). */
export interface ApprovalCall {
  readonly tool: string;
  /** Canonical fingerprint of the arguments: what the approval is bound to. */
  readonly fingerprint: string;
  /**
   * The arguments in clear, for the creator, while the request is open. `null` once
   * the request is decided or expired: the sealed copy is erased then and only the
   * fingerprint remains.
   */
  readonly arguments: unknown;
  readonly arguments_erased: boolean;
  /** The slices the call touches, in their wire form; `null` when the audit holds no entry. */
  readonly slices: readonly string[] | null;
  /** Every risk the call counts against, the gated one included. */
  readonly risks: readonly TouchedRiskLine[];
}

/** The gate of one risk an approval request covers, as the mission holds it now. */
export interface ApprovalGateLine {
  readonly risk_id: RiskId;
  readonly label: string;
  readonly policy: Gate | null;
  readonly open_until: Iso8601 | null;
}

/** The approval a grant produced, as the creator follows it. */
export interface GrantedApproval {
  readonly id: string;
  readonly expires_at: Iso8601;
  readonly consumed_at: Iso8601 | null;
  readonly state: 'usable' | 'consumed' | 'expired';
}

export interface ApprovalView {
  readonly kind: 'approval';
  readonly request: RequestSummary;
  readonly mission: RequestMissionView;
  /** Who asked; `null` when the session holds no trace of the refused call. */
  readonly asker: RequestAsker | null;
  readonly period: CurrentPeriod;
  readonly call: ApprovalCall;
  /** The gate of the request's first risk now: the policy's, and whether it is open for the period. */
  readonly gate: { readonly policy: Gate | null; readonly open_until: Iso8601 | null };
  /** The gate of every risk the request covers, in its order (`gate` is the first). */
  readonly gates: readonly ApprovalGateLine[];
  /** Set once the request was granted with an approval. */
  readonly approval: GrantedApproval | null;
  /** How long a yes stays usable (`approvals.expiry`), in seconds. */
  readonly approval_valid_seconds: number;
  /** Last events of the mission's session, most recent first. */
  readonly events: readonly SessionEventLine[];
  /** The three actions with their consequence; empty once the request is not open. */
  readonly options: readonly ApprovalOption[];
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
  | {
      readonly ok: false;
      readonly reason: 'invalid';
      readonly problem: ClaimProblem | ApprovalProblem;
    };

/** Thrown inside the decision transaction to roll it back with a reason. */
class ClaimProblemError extends Error {
  constructor(readonly problem: ClaimProblem) {
    super(problem.message);
    this.name = 'ClaimProblemError';
  }
}

/** The same, for an approval request: nothing is written, the arguments stay sealed. */
class ApprovalProblemError extends Error {
  constructor(readonly problem: ApprovalProblem) {
    super(problem.message);
    this.name = 'ApprovalProblemError';
  }
}

interface AppliedApproval extends RequestDecisionOutcome {
  readonly act: AdminAct;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown>;
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
  // single-process only by nature: catalog labels derived from the plugin registry,
  // which is immutable after boot, so replicas cannot disagree; no shared replacement
  // is needed (a per-process memo of a pure function of the build).
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
      summaries.push(
        this.summaryOf(
          request,
          { id: request.missionId, name },
          now,
          await this.resourceOf(request),
        ),
      );
    }
    return summaries;
  }

  /** The badge of the "Requests" entry of the application bar. */
  async openCount(user: RequestActor): Promise<number> {
    const now = this.deps.clock.now();
    const open = await this.deps.store.requests.listOpenForCreator(user.id);
    return open.filter((request) => effectiveState(request, now) === 'open').length;
  }

  /**
   * "Waiting for you": the inbox, each request with who asked and what is left of
   * the permissions it is about (spec §4.2). Oldest first, like `inbox`. Read-only:
   * the same access rule — the creator's open requests and nothing else.
   */
  async waiting(user: RequestActor): Promise<WaitingItem[]> {
    const now = this.deps.clock.now();
    const open = await this.deps.store.requests.listOpenForCreator(user.id);
    const missions = new Map<string, MissionRecord | null>();
    const items: WaitingItem[] = [];
    for (const request of open) {
      if (effectiveState(request, now) !== 'open') continue;
      let mission = missions.get(request.missionId);
      if (mission === undefined) {
        mission = await this.deps.store.missions.getById(request.missionId);
        missions.set(request.missionId, mission);
      }
      if (!mission) continue;
      const budget = budgetMissionOf(mission);
      const { period, consumed } = await this.budget.usageOf(budget, now);
      items.push({
        request: this.summaryOf(request, mission, now, await this.resourceOf(request)),
        asker: await this.askerOf(request),
        budget: request.riskIds.flatMap((riskId) => {
          const entry = budget.policy.find((candidate) => candidate.risk_id === riskId);
          return entry ? [this.lineOf(entry, consumed)] : [];
        }),
        period,
        period_seconds: mission.periodSeconds,
      });
    }
    return items;
  }

  /**
   * The requests of this creator's missions that are no longer open and were
   * answered — or expired — at or after `since`, most recent first. What "Answered
   * today" counts.
   */
  async answered(user: RequestActor, since: Date): Promise<RequestSummary[]> {
    const now = this.deps.clock.now();
    const from = since.getTime();
    const summaries: RequestSummary[] = [];
    for (const mission of await this.deps.store.missions.listForCreator(user.id)) {
      for (const request of await this.deps.store.requests.listForMission(mission.id)) {
        const summary = this.summaryOf(request, mission, now);
        if (summary.state === 'open') continue;
        if (Date.parse(closedAt(summary)) >= from) summaries.push(summary);
      }
    }
    return summaries.sort((a, b) => closedAt(b).localeCompare(closedAt(a)));
  }

  /** The creator's view of one request. */
  async view(user: RequestActor, requestId: string): Promise<ViewResult> {
    const owned = await this.own(user, requestId);
    if (!owned) return { outcome: 'forbidden' };
    const { request, mission } = owned;
    const now = this.deps.clock.now();
    const summary = this.summaryOf(request, mission, now, await this.resourceOf(request));
    if (request.kind !== 'claim') {
      return { outcome: 'ok', view: await this.approvalView(request, mission, summary, now) };
    }

    const budget = budgetMissionOf(mission);
    const { session_id, state, period, consumed } = await this.budget.usageOf(budget, now);
    const lines = budget.policy.map((entry) => this.lineOf(entry, consumed));
    const risk = lines.find((line) => line.risk_id === request.riskId) ?? null;
    const events = await this.lastEvents(session_id);

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
          period_seconds: mission.periodSeconds,
        },
        asker: await this.askerOf(request),
        period,
        risk,
        other_risks: lines.filter((line) => line.risk_id !== request.riskId),
        events: events.map(eventLineOf),
        options:
          summary.state === 'open'
            ? claimOptions(situationOf(budget, state.kind, period, request, consumed, now))
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
      case 'approval': {
        const parsed = parseApprovalDecision(raw);
        if (!parsed.ok) return { ok: false, reason: 'invalid', problem: parsed.problem };
        return this.decideApproval(user, requestId, parsed.decision);
      }
    }
  }

  /**
   * The creator's answer to an approval request (spec §3.5). One transaction of
   * the store holds the state change, the erasure of the sealed arguments and
   * the effect: an approval bound to the call (`grant`), a `gate-opened` event
   * for the current period (`open-gate`), or nothing (`refuse`). The executor
   * replays its call; the budget decides it again, quota and rate included.
   */
  async decideApproval(
    user: RequestActor,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<DecideResult> {
    const owned = await this.own(user, requestId);
    if (!owned) return { ok: false, reason: 'forbidden' };
    const { mission } = owned;
    if (owned.request.kind !== 'approval') {
      return { ok: false, reason: 'unsupported-kind', kind: owned.request.kind };
    }
    const now = this.deps.clock.now();
    const period = currentPeriod(budgetMissionOf(mission).period, now);
    const validitySeconds = this.deps.approvalValiditySeconds;

    let result;
    try {
      result = await this.deps.store.requests.decideApproval(requestId, user.id, (ctx) => {
        // The mission's status and expiry and the gate events are read inside the
        // transaction: the check and the write see the same rows.
        const budget = decidedMissionOf(mission, ctx.mission);
        const { tool } = ctx.request;
        if (!tool) throw new InvariantError(`approval request ${ctx.request.id} has no tool`);
        return applyApproval(ctx, {
          decision,
          user,
          period,
          expiresAt: toIso(new Date(now.getTime() + validitySeconds * MS_PER_SECOND)),
          situation: approvalSituationOf(
            budget,
            deriveMissionState(budget, [], now).kind,
            period,
            { ...ctx.request, tool },
            gateEventsOf(ctx, ctx.request.riskIds, period),
            validitySeconds,
          ),
        });
      });
    } catch (err) {
      if (err instanceof ApprovalProblemError) {
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
      // The tool and the fingerprint, never the arguments (spec §3.5, §6).
      after: {
        mission_id: mission.id,
        risk_id: request.riskId,
        risk_ids: request.riskIds,
        tool: request.tool,
        fingerprint: request.fingerprint,
        ...outcome.after,
      },
      delegated_client_id: null,
    });
    this.deps.logger.info('approval request decided', {
      request_id: request.id,
      mission_id: mission.id,
      risk_id: request.riskId,
      tool: request.tool,
      resolution: decision.resolution,
      user_id: user.id,
    });
    return { ok: true, request: this.summaryOf(request, mission, now) };
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
    const period = currentPeriod(budgetMissionOf(mission).period, now);

    let result;
    try {
      result = await this.deps.store.requests.decideClaim(requestId, user.id, (ctx) => {
        // The mission's status and expiry and the counters are read inside the
        // transaction: the check and the write see the same rows and numbers. Two
        // `extend-expiry` decisions cannot each be checked against the old expiry.
        const budget = decidedMissionOf(mission, ctx.mission);
        return applyClaim(ctx, {
          decision,
          user,
          period,
          situation: situationOf(
            budget,
            deriveMissionState(budget, [], now).kind,
            period,
            ctx.request,
            ctx.counters(period.start),
            now,
          ),
        });
      });
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

  /**
   * The creator's view of an approval request: the tool, the arguments in clear
   * while the request is open, the slices and the risks the call touches with
   * what is left of each, the gate, and the three actions. Called after `own()`
   * only — this is the one place the sealed arguments are opened.
   */
  private async approvalView(
    request: RequestRecord,
    mission: MissionRecord,
    summary: RequestSummary,
    now: Date,
  ): Promise<ApprovalView> {
    const { store } = this.deps;
    const { tool, fingerprint } = request;
    if (!tool || !fingerprint) {
      throw new InvariantError(`approval request ${request.id} has no tool or fingerprint`);
    }
    const budget = budgetMissionOf(mission);
    const { session_id, state, period, consumed } = await this.budget.usageOf(budget, now);
    const open = summary.state === 'open';

    const gateEvents = session_id
      ? await store.sessions.listEvents(session_id, {
          kinds: GATE_EVENT_KINDS,
          since: period.start,
        })
      : [];
    const opened = openedGatesOf(gateEvents, period);
    const gates: ApprovalGateLine[] = request.riskIds.map((riskId) => ({
      risk_id: riskId,
      label: this.labelOf(riskId),
      policy: budget.policy.find((entry) => entry.risk_id === riskId)?.gate ?? null,
      open_until: opened.has(riskId) ? period.end : null,
    }));
    const [firstGate] = gates;
    if (!firstGate) throw new InvariantError(`approval request ${request.id} names no risk`);

    // What the call touches is the audit's to say: the pipeline wrote the entry of
    // the refused call with its slices and risks, keyed by the same fingerprint.
    const audited = await store.audit.latestCall({
      missionId: mission.id,
      tool,
      argumentsHash: fingerprint,
      refusalCode: 'approval-required',
    });
    const touched = new Set<RiskId>([...(audited?.risks_touched ?? []), ...request.riskIds]);
    const risks: TouchedRiskLine[] = budget.policy
      .filter((entry) => touched.has(entry.risk_id))
      .map((entry) => ({ ...this.lineOf(entry, consumed), gate: effectiveGate(entry, opened) }));

    const approval =
      request.state === 'granted' ? await store.approvals.getByRequest(request.id) : null;
    const events = await this.lastEvents(session_id);

    return {
      kind: 'approval',
      request: summary,
      mission: {
        id: mission.id,
        name: mission.name,
        state: state.kind,
        expires_at: mission.expiresAt,
        period_seconds: mission.periodSeconds,
      },
      asker: await this.askerOf(request),
      period,
      call: {
        tool,
        fingerprint,
        // An overdue request reads `expired` before the sweeper erases its blob:
        // nothing is opened for it either.
        arguments: open ? await store.requests.getArguments(request.id) : null,
        arguments_erased: !open,
        slices: audited ? audited.slices_executed.map(serializeSlice) : null,
        risks,
      },
      gate: { policy: firstGate.policy, open_until: firstGate.open_until },
      gates,
      approval: approval
        ? {
            id: approval.id,
            expires_at: approval.expiresAt,
            consumed_at: approval.consumedAt,
            state: approval.consumedAt
              ? 'consumed'
              : Date.parse(approval.expiresAt) <= now.getTime()
                ? 'expired'
                : 'usable',
          }
        : null,
      approval_valid_seconds: this.deps.approvalValiditySeconds,
      events: events.map(eventLineOf),
      options: open
        ? approvalOptions(
            approvalSituationOf(
              budget,
              state.kind,
              period,
              { ...request, tool },
              gateEvents,
              this.deps.approvalValiditySeconds,
            ),
          )
        : [],
    };
  }

  private async lastEvents(sessionId: string | null): Promise<EventRecord[]> {
    if (!sessionId) return [];
    return this.deps.store.sessions.listEvents(sessionId, {
      order: 'desc',
      limit: SESSION_EVENTS_SHOWN,
    });
  }

  /**
   * Who asked: the first refused call of the session that pointed to this request,
   * its holder named. Reads the refused calls recorded since the request was dropped
   * (a replay is refused again and points to the same request).
   */
  private async askerOf(request: RequestRecord): Promise<RequestAsker | null> {
    if (!request.sessionId) return null;
    const events = await this.deps.store.sessions.listEvents(request.sessionId, {
      kinds: [REFUSED_CALL_KIND],
      since: request.createdAt,
    });
    const asked = askedBy(events, request.id);
    if (!asked) return null;
    const member = asked.token_kind === 'member' && asked.holder !== null;
    const user = member && asked.holder ? await this.deps.store.users.getById(asked.holder) : null;
    return {
      token_kind: asked.token_kind,
      user_id: member ? asked.holder : null,
      holder: user ? (user.displayName ?? user.email) : asked.holder,
      agent_label: asked.agent_label,
      tool: asked.tool,
      refused_calls: asked.refused_calls,
    };
  }

  /** The request and its mission when `user` is the mission's creator; otherwise `null`. */
  private async own(user: RequestActor, requestId: string): Promise<OwnedRequest | null> {
    const request = await this.deps.store.requests.getById(requestId);
    if (!request) return null;
    const stored = await this.deps.store.missions.getById(request.missionId);
    if (!stored || stored.creatorUserId !== user.id) return null;
    // `orphaned` is derived, never stored: the view and every decision read the
    // mission as the creator's authority makes it at this instant.
    return { request, mission: await this.deps.grounds.derive(stored) };
  }

  /**
   * The resource the call of an approval request resolved to: the pipeline wrote
   * it on the audit entry of the refused call, keyed by the tool and the
   * fingerprint the request holds. `null` for a claim.
   */
  private async resourceOf(request: RequestRecord): Promise<string | null> {
    if (request.kind === 'claim' || !request.tool || !request.fingerprint) return null;
    const audited = await this.deps.store.audit.latestCall({
      missionId: request.missionId,
      tool: request.tool,
      argumentsHash: request.fingerprint,
      refusalCode: 'approval-required',
    });
    return audited?.resource_ref ?? null;
  }

  private summaryOf(
    request: RequestRecord,
    mission: { readonly id: string; readonly name: string },
    now: Date,
    /** `resourceOf(request)`, on the reads that head a page with the call. */
    resource: string | null = null,
  ): RequestSummary {
    return {
      id: request.id,
      kind: request.kind,
      state: effectiveState(request, now),
      risk_id: request.riskId,
      risk_label: this.labelOf(request.riskId),
      risks: request.riskIds.map((riskId) => ({ risk_id: riskId, label: this.labelOf(riskId) })),
      created_at: request.createdAt,
      expires_at: request.expiresAt,
      decided_at: request.decidedAt,
      decision: request.decision,
      url: requestUrl(this.deps.publicUrl, request.id),
      mission: { id: mission.id, name: mission.name },
      tool: request.tool,
      call:
        request.kind !== 'claim' && request.tool
          ? {
              tool: request.tool,
              title: toolTitleOf(this.deps.registry, request.tool),
              resource,
            }
          : null,
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

/** When a request stopped being open: its decision, or its expiry when nobody answered. */
function closedAt(summary: RequestSummary): Iso8601 {
  return summary.decided_at ?? summary.expires_at;
}

function providerOf(riskId: RiskId): string | null {
  return parseRiskId(riskId)?.provider ?? null;
}

/**
 * The mission a decision is checked against: the status and the expiry the store
 * holds inside the decision's transaction, under the `orphaned` verdict `own()`
 * derived just before it. The derivation reads the creator's authority through
 * asynchronous repositories and cannot run in the synchronous callback, so the verdict
 * stays a read of that instant; the policy (quota, gate) is the one `own()` read too.
 */
function decidedMissionOf(derived: MissionRecord, stored: StoredMissionFacts): BudgetMission {
  const orphaned = derived.status === 'orphaned' && stored.status === 'active';
  return {
    ...budgetMissionOf(derived),
    status: orphaned ? 'orphaned' : stored.status,
    expires_at: stored.expiresAt,
  };
}

function situationOf(
  mission: BudgetMission,
  missionState: MissionState['kind'],
  period: CurrentPeriod,
  request: Pick<RequestRecord, 'riskId' | 'expiresAt'>,
  consumed: ReadonlyMap<RiskId, number>,
  now: Date,
): ClaimSituation {
  const { riskId } = request;
  return {
    now,
    mission_state: missionState,
    expires_at: mission.expires_at,
    period_end: period.end,
    risk_id: riskId,
    quota: mission.policy.find((entry) => entry.risk_id === riskId)?.quota ?? null,
    consumed: consumed.get(riskId) ?? 0,
    request_expires_at: request.expiresAt,
  };
}

function gateEventsOf(
  ctx: ApprovalDecisionContext,
  riskIds: readonly RiskId[],
  period: CurrentPeriod,
): EventRecord[] {
  return ctx.riskEvents({ kinds: GATE_EVENT_KINDS, riskIds, since: period.start });
}

function approvalSituationOf(
  mission: BudgetMission,
  missionState: MissionState['kind'],
  period: CurrentPeriod,
  /** The request with the tool its callers already checked is there. */
  request: Pick<RequestRecord, 'riskIds' | 'expiresAt'> & { readonly tool: string },
  gateEvents: readonly EventRecord[],
  approvalValiditySeconds: number,
): ApprovalSituation {
  const opened = openedGatesOf(gateEvents, period);
  return {
    mission_state: missionState,
    period_end: period.end,
    risks: request.riskIds.map((riskId) => ({
      risk_id: riskId,
      gate: mission.policy.find((entry) => entry.risk_id === riskId)?.gate ?? null,
      gate_open: opened.has(riskId),
    })),
    tool: request.tool,
    approval_valid_seconds: approvalValiditySeconds,
    request_expires_at: request.expiresAt,
  };
}

interface ApplyApprovalInput {
  readonly decision: ApprovalDecision;
  readonly user: RequestActor;
  readonly period: CurrentPeriod;
  /** When the approval of a grant stops being usable. */
  readonly expiresAt: Iso8601;
  readonly situation: ApprovalSituation;
}

/** Runs inside the store's transaction: check, effect, event. Synchronous. */
function applyApproval(ctx: ApprovalDecisionContext, input: ApplyApprovalInput): AppliedApproval {
  const { decision, user, period, situation } = input;
  const problem = checkApprovalDecision(situation, decision);
  if (problem) throw new ApprovalProblemError(problem);
  const { request } = ctx;
  const { riskId, tool, fingerprint } = request;
  if (!tool || !fingerprint) {
    throw new InvariantError(`approval request ${request.id} has no tool or fingerprint`);
  }

  switch (decision.resolution) {
    case 'grant': {
      // One approval for the call: it covers every gated risk the request lists.
      const approval = ctx.createApproval(input.expiresAt);
      const granted = {
        approval_id: approval.id,
        approval_expires_at: approval.expiresAt,
        risk_ids: approval.riskIds,
      };
      ctx.recordEvent({
        kind: 'approval',
        riskId,
        actorUserId: user.id,
        details: {
          request_id: request.id,
          approval_id: approval.id,
          tool,
          fingerprint,
          expires_at: approval.expiresAt,
          risk_ids: approval.riskIds,
        },
      });
      return {
        state: 'granted',
        decision: { resolution: decision.resolution, ...granted },
        act: 'approval-granted',
        before: null,
        after: { resolution: decision.resolution, ...granted },
      };
    }
    case 'open-gate': {
      // `checkApprovalDecision` refused a mission whose period never ends.
      if (period.end === null) throw new InvariantError('a gate is opened until a period end');
      const span = { period_start: period.start, period_end: period.end };
      // Every gate of the request that is still closed, one event each: an opening is
      // read per risk (`openedGatesOf`), and `checkApprovalDecision` found at least one.
      const opened = closedGates(situation);
      for (const openedRisk of opened) {
        const recorded = ctx.recordEvent({
          kind: 'gate-opened',
          riskId: openedRisk,
          actorUserId: user.id,
          details: { request_id: request.id, ...span },
        });
        // The event is the opening: without a session to carry it nothing was opened.
        if (!recorded) throw new InvariantError(`request ${request.id} has no session`);
      }
      if (opened.length === 0) throw new InvariantError(`request ${request.id} opens no gate`);
      return {
        state: 'granted',
        decision: { resolution: decision.resolution, ...span, opened_risk_ids: opened },
        act: 'gate-opened',
        before: { gate: 'approval' },
        after: { resolution: decision.resolution, gate: 'auto', ...span, opened_risk_ids: opened },
      };
    }
    case 'refuse': {
      ctx.recordEvent({
        kind: 'request',
        riskId,
        actorUserId: user.id,
        details: { request_id: request.id, request_kind: request.kind, state: 'refused' },
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
      // The claimed risk, and no other: a claim on one risk reopens nothing else.
      const given = ctx.resetCounter(period.start, riskId);
      const credits: Record<RiskId, number> = given > 0 ? { [riskId]: given } : {};
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
