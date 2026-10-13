/**
 * Call pipeline skeleton — the v5 order of checks, with hook points.
 *
 * Spec: docs/spec/vaubaan-gateway.md §4.1 ("classification by the plugin,
 * intersection with the catalog, check `risks_touched ⊆ accepted_risks`,
 * budget check, upstream credential mint, forward, audit"), §3.1 ("refused
 * with `resource-not-in-mission`, before any risk is evaluated"), §2.3
 * (connection and mission states), §6 (three credentials, one trust domain),
 * §8 (one audit entry per call, allowed or refused).
 *
 * Order of a `tools/call`:
 *
 *   authenticate(bearer, door)      wrong-credential-kind  (this module)
 *   mission state                   mission-inactive       (this module)
 *   resource resolution             resource-not-in-mission (ResourceStage, execution door)
 *   connection availability         connection-unavailable (this module)
 *   classify + risk decision        risk-not-accepted      (RiskStage over risk-gateway.ts)
 *   budget / rate / gate            budget-exhausted, rate-limited, approval-required (BudgetStage, P1.3)
 *   upstream mint + forward         —                      (UpstreamStage, execution door)
 *   audit                           always, exactly once   (AuditWriter, P0.3 store)
 *
 * A refused call decrements nothing and still produces an audit entry. An
 * allowed call that fails upstream keeps `decision: 'allowed'` and records
 * `upstream_error` (the decision is what the gateway did) — including when
 * the failure is the provider rejecting the connection's credential for
 * good: the upstream stage then throws `UpstreamRefusalError` and the
 * outcome carries the `connection-unavailable` refusal the agent reads.
 * `upstream_error` is a bounded summary the host built (`UpstreamFailureError
 * .summary`), never the provider's text: providers echo input in their
 * errors, and the audit keeps no trace of the arguments but their hash. The
 * provider's text goes to the caller only, on the `failed` outcome. An
 * audit write that fails propagates: no call completes without its entry.
 *
 * A decision stage that THROWS (resource, risk, budget: a classifier that is
 * not total, a store failure) has decided nothing: the call is refused, and
 * the refusal is audited like any other (`CallPipeline.attempt`) with a
 * reason built from the stage and the error's class name alone. The thrown
 * value goes to `onStageError` for the host's log, never to the audit.
 *
 * Streaming (spec §4.1 "the decision is made before the stream starts"): a
 * call may carry `onPart`; the upstream stage hands it each part of a result
 * the provider delivers progressively. The order above is unchanged — the
 * stage runs last — and so is the audit: one entry, written when the forward
 * ends, whose `upstream_latency_ms` therefore covers the whole stream and
 * whose `upstream_error` records a stream that broke midway.
 *
 * What is deliberately NOT here: JSON-RPC routing, `tools/list` filtering,
 * the catalog endpoint, the event stream — that is the door
 * (`apps/gateway/src/server/execution`), which calls `authenticate` then
 * `CallPipeline.execute` and serializes a refusal as the JSON-RPC error
 * `refusalToRpcError` describes (code, message, the whole refusal as `data`).
 */

import {
  acceptedRisksOf,
  type McpToolContent,
  type MissionStatus,
  type RiskId,
} from '@vaubaan/shared';
import type { AuditWriter, CallAuditEntry } from './audit.ts';
import {
  AuthError,
  isRefusal,
  isUnavailableConnectionStatus,
  refuse,
  type Refusal,
} from './errors.ts';
import { fingerprintArguments, unfaithfulArgument } from './fingerprint.ts';
import type { CallVerdict } from './risk-gateway.ts';
import {
  tokenAttributionOf,
  type BearerKind,
  type DelegationContext,
  type Door,
  type MissionConnection,
  type MissionContext,
  type MissionResource,
} from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Doors and credentials
// ─────────────────────────────────────────────────────────────────────────────

/** Which bearer each door accepts. A human session opens no door. */
export const EXPECTED_CREDENTIAL_BY_DOOR: Readonly<Record<Door, BearerKind>> = {
  execution: 'mission-token',
  management: 'delegated-token',
};

/** A bearer the resolver identified, whatever door it was presented at. */
export type ResolvedCredential =
  | { readonly kind: 'mission-token'; readonly context: MissionContext }
  | { readonly kind: 'delegated-token'; readonly delegation: DelegationContext }
  | { readonly kind: 'human-session'; readonly user_id: string };

/**
 * Identifies a raw bearer. Implemented by the execution door over the store:
 * prefix lookup, slow-hash verification, context load, cache. Returns `null`
 * for an unknown, revoked or malformed bearer; never guesses a kind.
 */
export interface CredentialResolver {
  resolve(bearer: string): Promise<ResolvedCredential | null>;
}

/** Pure door check: the bearer kind must be the one the door expects. */
export function checkDoor(presented: BearerKind, door: Door): Refusal | null {
  const expected = EXPECTED_CREDENTIAL_BY_DOOR[door];
  if (presented === expected) return null;
  return refuse.wrongCredentialKind({ door, presented, expected });
}

/** Extract the bearer from an `Authorization` header. */
export function parseBearer(authorizationHeader: string | null | undefined): string {
  if (!authorizationHeader || !authorizationHeader.toLowerCase().startsWith('bearer ')) {
    throw new AuthError('missing or malformed Authorization header (expected `Bearer <token>`).');
  }
  const raw = authorizationHeader.slice('bearer '.length).trim();
  if (!raw) throw new AuthError('empty bearer.');
  return raw;
}

export class DoorAuthenticator {
  constructor(private readonly resolver: CredentialResolver) {}

  /**
   * Resolve the bearer and check it against the door.
   *
   * - Unknown or malformed bearer → throws `AuthError` (401). Not a refusal:
   *   nothing was identified.
   * - Identified bearer of the wrong kind → `wrong-credential-kind` refusal,
   *   whatever the kind: a mission token at the management door, a delegated
   *   token at the execution door, a session at either.
   * - Otherwise the credential, whose kind matches the door.
   */
  async authenticate(
    authorizationHeader: string | null | undefined,
    door: Door,
  ): Promise<ResolvedCredential | Refusal> {
    const bearer = parseBearer(authorizationHeader);
    const credential = await this.resolver.resolve(bearer);
    if (!credential) throw new AuthError('unknown or revoked bearer.');
    return checkDoor(credential.kind, door) ?? credential;
  }

  /** Execution door: `authenticate(bearer, 'execution')` narrowed to the
   *  mission context. */
  async authenticateMission(
    authorizationHeader: string | null | undefined,
  ): Promise<MissionContext | Refusal> {
    const outcome = await this.authenticate(authorizationHeader, 'execution');
    if (isRefusal(outcome)) return outcome;
    if (outcome.kind !== 'mission-token') {
      // Unreachable: checkDoor guarantees the kind. Kept for the type system.
      return refuse.wrongCredentialKind({
        door: 'execution',
        presented: outcome.kind,
        expected: 'mission-token',
      });
    }
    return outcome.context;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mission and connection state (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Why a mission is inactive, per status. Keyed by status so a new status
 *  fails to compile until it has its reason. */
const INACTIVE_MISSION_REASON: Readonly<
  Record<Exclude<MissionStatus, 'active'>, (expires_at: string | null) => string>
> = {
  expired: (expires_at) => `the mission expired at ${expires_at ?? 'an unknown time'}`,
  orphaned: () =>
    'the authority behind the mission is missing right now (share or connection revoked, creator out of the group that grounded it, creator gone)',
  revoked: () => 'the mission was revoked by its creator',
};

/** `mission-inactive` when the mission's status or expiry says so. */
export function checkMissionActive(ctx: MissionContext, now: Date): Refusal | null {
  const { status, expires_at } = ctx.mission;
  if (status !== 'active') {
    return refuse.missionInactive({ status, reason: INACTIVE_MISSION_REASON[status](expires_at) });
  }
  if (expires_at === null) return null;
  const expiresAtMs = Date.parse(expires_at);
  // An expiry that cannot be read is treated as passed: `NaN <= now` is
  // false, so comparing alone would let a corrupt row never expire.
  if (Number.isNaN(expiresAtMs)) {
    return refuse.missionInactive({
      status: 'expired',
      reason: `the mission's expiry '${expires_at}' is unreadable; it is treated as passed`,
    });
  }
  if (expiresAtMs <= now.getTime()) {
    return refuse.missionInactive({
      status: 'expired',
      reason: `the mission expired at ${expires_at}`,
    });
  }
  return null;
}

/** `connection-unavailable` when the connection is `expired` or `revoked`.
 *  An `unowned` connection keeps serving its missions (spec §2: "missions
 *  keep running, but nobody can share or reconnect"). */
export function checkConnectionAvailable(connection: MissionConnection): Refusal | null {
  if (!isUnavailableConnectionStatus(connection.status)) return null;
  return refuse.connectionUnavailable({
    connection: { id: connection.id, name: connection.display_name },
    status: connection.status,
    owner: { kind: connection.owner.kind, display: connection.owner.display },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Call request and stage contracts (hook points)
// ─────────────────────────────────────────────────────────────────────────────

export interface ClientOrigin {
  readonly ip: string | null;
  readonly user_agent: string | null;
}

export interface CallRequest {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** Optional free-form attribution (spec §0 "Mission token"). */
  readonly agent_label: string | null;
  readonly client: ClientOrigin;
  /**
   * Streaming (spec §4.1): receives each part of the result as the provider
   * delivers it. Only the upstream stage calls it, so it runs after the
   * decision — mission state, resources, risks, budget decrement — and never
   * for a refused call. Absent: the caller reads the complete result alone.
   */
  readonly onPart?: (part: McpToolContent) => Promise<void>;
  /**
   * Aborted when the caller is gone (disconnect, MCP cancellation). The
   * upstream stage reads it between two parts of a streamed result; it
   * never interrupts a provider call in flight.
   */
  readonly signal?: AbortSignal;
}

/** The connection and resource a call targets. */
export interface CallTarget {
  readonly connection: MissionConnection;
  /** Null for tools that address the connection as a whole. */
  readonly resource: MissionResource | null;
}

/**
 * Resolves the target of a call from its arguments and the mission's
 * selection, refusing `resource-not-in-mission` for a ref outside it
 * (spec §3.1). Implemented by the execution door over the plugin registry
 * and the classifier's slices.
 *
 * A call that has no target at all — a tool no registered plugin owns, a
 * provider the mission holds no connection for — is a structural rejection
 * (`reason`, no refusal code): the pipeline audits it as `refused` with
 * `refusal_code: null` and returns `rejected`.
 */
export type ResourceResolution =
  | { readonly ok: true; readonly target: CallTarget }
  | { readonly ok: false; readonly refusal: Refusal }
  | { readonly ok: false; readonly reason: string };

export interface ResourceStage {
  resolve(ctx: MissionContext, call: CallRequest): Promise<ResourceResolution>;
}

/**
 * Classify and decide on risks. The default implementation wraps
 * `evaluateCallForToken` (risk-gateway.ts) with the plugin classifier and
 * the provider catalog (P1.2 wires the registry).
 */
export interface RiskStage {
  evaluate(ctx: MissionContext, call: CallRequest, target: CallTarget): Promise<CallVerdict>;
}

export type BudgetDecision =
  | {
      readonly outcome: 'allowed';
      readonly session_id: string;
      /** Remaining quota per touched risk after the decrement. */
      readonly remaining: Readonly<Record<RiskId, number>>;
      /** Approval consumed, when the gate was `approval`. */
      readonly approval_id: string | null;
    }
  | { readonly outcome: 'refused'; readonly refusal: Refusal };

/**
 * Budget, rate limit and gate, decided and decremented atomically (spec §3.2,
 * §3.3, §3.5; plan §3.5). Feature P1.3. Refuses `budget-exhausted`,
 * `rate-limited` or `approval-required`; a refusal decrements nothing.
 */
export interface BudgetStage {
  decide(
    ctx: MissionContext,
    call: CallRequest,
    input: { readonly risks_touched: readonly RiskId[]; readonly now: Date },
  ): Promise<BudgetDecision>;
}

/** Mint or decrypt the ephemeral upstream credential, forward, return the
 *  provider's result. The executor never sees the credential (spec §2.4).
 *  Throws `UpstreamRefusalError` when the provider rejected the credential
 *  and it could not be refreshed (spec §2.3 connection `expired`), and
 *  `UpstreamFailureError` for any other failure. A throw of another type is
 *  still an upstream failure, audited by its class name alone. */
export interface UpstreamStage {
  execute(ctx: MissionContext, call: CallRequest, target: CallTarget): Promise<unknown>;
}

/**
 * Thrown by an `UpstreamStage` when the call was allowed and counted, but the
 * connection turned out to be unusable while forwarding: the provider
 * rejected the credential and the refresh failed, or the connection was
 * revoked between the decision and the forward. The pipeline keeps the audit
 * entry `decision: 'allowed'` with `upstream_error` (the budget decision
 * stands, the credit is not refunded — ADR atomic-budget-accounting) and
 * returns the refusal on the `failed` outcome so the door answers
 * `connection-unavailable` instead of an opaque provider error.
 */
export class UpstreamRefusalError extends Error {
  constructor(
    readonly refusal: Refusal,
    message?: string,
  ) {
    super(message ?? refusal.hint);
    this.name = 'UpstreamRefusalError';
  }
}

/** Upper bound of what `upstream_error` stores for one call. */
export const UPSTREAM_ERROR_SUMMARY_MAX_LENGTH = 200;

const ERROR_CLASS_NAME_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const ANONYMOUS_ERROR_CLASS = 'Error';

/**
 * The class name of a thrown value, for an audit summary. Only an
 * identifier-shaped name is returned: an error whose `name` was set to free
 * text (or a value that is not an error) reads `Error`.
 */
export function upstreamErrorClassName(thrown: unknown): string {
  if (!(thrown instanceof Error)) return ANONYMOUS_ERROR_CLASS;
  return ERROR_CLASS_NAME_SHAPE.test(thrown.name) ? thrown.name : ANONYMOUS_ERROR_CLASS;
}

/**
 * Thrown by an `UpstreamStage` when the call was allowed and counted and the
 * provider call failed. It separates what the two readers of the failure get:
 *
 * - `summary` is written to the immutable audit (`upstream_error`). The stage
 *   builds it from what the host knows — the provider id, the HTTP status,
 *   the error's class name — and never from the provider's text, which can
 *   echo the call's arguments. The pipeline bounds its length.
 * - `detail` is the provider's own message. It goes to the caller of the
 *   tool, which knows its own arguments, on the `failed` outcome, and is
 *   stored nowhere.
 */
export class UpstreamFailureError extends Error {
  readonly summary: string;
  readonly detail: string;
  /** HTTP status of the provider's answer, when the failure carries one. */
  readonly status: number | null;

  constructor(input: {
    readonly summary: string;
    readonly detail: string;
    readonly status: number | null;
    readonly cause?: unknown;
  }) {
    super(input.detail, { cause: input.cause });
    this.name = 'UpstreamFailureError';
    this.summary = input.summary;
    this.detail = input.detail;
    this.status = input.status;
  }
}

/** What the audit and the caller each read of a failed forward. */
interface UpstreamFailure {
  /** Stored as `upstream_error`: host-built, bounded. */
  readonly summary: string;
  /** Returned on the `failed` outcome: the provider's text. */
  readonly detail: string;
  readonly refusal: Refusal | null;
}

function describeUpstreamFailure(thrown: unknown): UpstreamFailure {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  if (thrown instanceof UpstreamRefusalError) {
    const { refusal } = thrown;
    const status = 'status' in refusal ? `: ${refusal.status}` : '';
    return {
      summary: `${refusal.code}${status}`,
      detail: `${refusal.code}: ${message}`,
      refusal,
    };
  }
  if (thrown instanceof UpstreamFailureError) {
    return { summary: thrown.summary, detail: thrown.detail, refusal: null };
  }
  return {
    summary: `upstream call failed (${upstreamErrorClassName(thrown)})`,
    detail: message,
    refusal: null,
  };
}

/** Longest structural reason an audit entry keeps. */
export const AUDIT_REASON_MAX_LENGTH = 500;
/** What stands for an argument value in the audit copy of a reason. */
export const ARGUMENT_PLACEHOLDER = '[argument]';
/** Shorter values are not looked for: they would match inside ordinary words. */
const MIN_ARGUMENT_VALUE_LENGTH = 3;

/** Every string in the arguments, and every finite number as text, at any depth. */
function argumentValues(args: unknown, out: Set<string>): Set<string> {
  if (typeof args === 'string') {
    if (args.length >= MIN_ARGUMENT_VALUE_LENGTH) out.add(args);
  } else if (typeof args === 'number') {
    const text = String(args);
    if (Number.isFinite(args) && text.length >= MIN_ARGUMENT_VALUE_LENGTH) out.add(text);
  } else if (Array.isArray(args)) {
    for (const item of args) argumentValues(item, out);
  } else if (typeof args === 'object' && args !== null) {
    for (const member of Object.values(args)) argumentValues(member, out);
  }
  return out;
}

/**
 * The reason of a structural rejection as the audit keeps it (spec §6, §8: the audit
 * holds the fingerprint of the arguments, never the arguments). A plugin's denial
 * may quote the value it refuses — `path: 'secrets/prod.env' is not …` — which is
 * right for the caller, who sent it, and wrong for an entry others read for as long
 * as retention says. Every argument value found in the reason is replaced, longest
 * first, and the whole is bounded.
 */
export function auditReason(reason: string, args: unknown): string {
  let kept = reason;
  const values = [...argumentValues(args, new Set())].sort((a, b) => b.length - a.length);
  for (const value of values) kept = kept.split(value).join(ARGUMENT_PLACEHOLDER);
  return kept.length > AUDIT_REASON_MAX_LENGTH
    ? `${kept.slice(0, AUDIT_REASON_MAX_LENGTH - 1)}…`
    : kept;
}

/** The stages that run before the decision is final; the upstream stage has its own failure path. */
export const DECISION_STAGES = ['resource', 'risk', 'budget'] as const;
export type DecisionStage = (typeof DECISION_STAGES)[number];

/**
 * The reason of a call refused because a decision stage threw. Built by the host
 * from the stage and the class name of what was thrown, never from its message: a
 * classifier's error text can quote the arguments it choked on, and this reason is
 * stored in the audit.
 */
export function stageFailureReason(stage: DecisionStage, thrown: unknown): string {
  return (
    `Vaubaan could not decide this call: the ${stage} stage failed (${upstreamErrorClassName(thrown)}). ` +
    `The call was refused and nothing was executed; the operator finds the error in the instance log.`
  );
}

export interface CallPipelineDeps {
  readonly resources: ResourceStage;
  readonly risks: RiskStage;
  readonly budget: BudgetStage;
  readonly upstream: UpstreamStage;
  readonly audit: AuditWriter;
  /** Clock, injectable for tests. */
  readonly now?: () => Date;
  /**
   * Told when a decision stage throws (a classifier bug, a store failure), with
   * the thrown value: the host logs it. The call is refused and audited whether
   * or not an observer is given, and whatever the observer does.
   */
  readonly onStageError?: (stage: DecisionStage, error: unknown, call: CallRequest) => void;
}

export type CallOutcome =
  | { readonly kind: 'allowed'; readonly result: unknown; readonly audit: CallAuditEntry }
  | { readonly kind: 'refused'; readonly refusal: Refusal; readonly audit: CallAuditEntry }
  | {
      /** Structural refusal without a code: unknown tool, classifier denial,
       *  catalog not loaded (fail closed). */
      readonly kind: 'rejected';
      readonly reason: string;
      readonly audit: CallAuditEntry;
    }
  | {
      /** Allowed, then the provider failed. `error` is the provider's detail,
       *  for the caller only: the audit entry holds a host-built summary
       *  (`audit.upstream_error`). `refusal` is set when the failure is a
       *  structured one the agent must read (`connection-unavailable` after a
       *  rejected refresh). */
      readonly kind: 'failed';
      readonly error: string;
      readonly refusal: Refusal | null;
      readonly audit: CallAuditEntry;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

/** A call whose target is resolved and available, with its audit entry so far. */
interface TargetedCall {
  readonly target: CallTarget;
  readonly entry: CallAuditEntry;
}

/** A call the risk stage allowed, with its audit entry so far. */
interface ClassifiedCall {
  readonly risks_touched: readonly RiskId[];
  readonly entry: CallAuditEntry;
}

/** A stage result that ends the call. Every `CallOutcome` carries its `audit` entry; no intermediate value does. */
function isOutcome(
  x: CallOutcome | TargetedCall | ClassifiedCall | CallAuditEntry,
): x is CallOutcome {
  return 'audit' in x;
}

export class CallPipeline {
  private readonly now: () => Date;

  constructor(private readonly deps: CallPipelineDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * One `tools/call`, in the order of the header table. Each stage either
   * ends the call (an audited `CallOutcome`) or hands the next stage the
   * audit entry enriched with what it learned.
   */
  async execute(ctx: MissionContext, call: CallRequest): Promise<CallOutcome> {
    const now = this.now();
    // Before the fingerprint is taken: a value JSON cannot carry (`1e999` parses to
    // Infinity, written back as `null`) would be approved as one thing and executed
    // as another. Structural, like an unknown tool: no stage sees the call.
    const unfaithful = unfaithfulArgument(call.args);
    if (unfaithful) {
      return this.rejected(
        // Its hash is still the canonical one (the value reads `null` there), so the
        // entry joins the others of the same arguments. A BigInt has no canonical
        // form and cannot come from a JSON body: the entry then carries no arguments.
        this.baseEntry(ctx, unfaithful.kind === 'bigint' ? { ...call, args: {} } : call, now),
        `argument '${unfaithful.path}' is ${unfaithful.value}: arguments must be JSON values (a finite number, a string, a boolean, null, an array or an object).`,
      );
    }
    const base = this.baseEntry(ctx, call, now);

    const inactive = checkMissionActive(ctx, now);
    if (inactive) return this.refused(base, inactive);

    const targeted = await this.resolveTarget(ctx, call, base);
    if (isOutcome(targeted)) return targeted;

    const classified = await this.decideRisks(ctx, call, targeted);
    if (isOutcome(classified)) return classified;

    const decided = await this.decideBudget(ctx, call, classified, now);
    if (isOutcome(decided)) return decided;

    return this.forward(ctx, call, targeted.target, decided);
  }

  /** Resource resolution, then connection availability. */
  private async resolveTarget(
    ctx: MissionContext,
    call: CallRequest,
    base: CallAuditEntry,
  ): Promise<CallOutcome | TargetedCall> {
    const attempt = await this.attempt('resource', call, base, () =>
      this.deps.resources.resolve(ctx, call),
    );
    if (!attempt.ok) return attempt.outcome;
    const resolved = attempt.value;
    if (!resolved.ok) {
      return 'refusal' in resolved
        ? this.refused(base, resolved.refusal)
        : this.rejected(base, resolved.reason, call.args);
    }
    const { target } = resolved;
    const entry: CallAuditEntry = {
      ...base,
      connection_id: target.connection.id,
      resource_ref: target.resource?.ref ?? null,
    };

    const unavailable = checkConnectionAvailable(target.connection);
    if (unavailable) return this.refused(entry, unavailable);
    return { target, entry };
  }

  /** Classification and the risk decision. */
  private async decideRisks(
    ctx: MissionContext,
    call: CallRequest,
    targeted: TargetedCall,
  ): Promise<CallOutcome | ClassifiedCall> {
    const { target, entry } = targeted;
    const attempt = await this.attempt('risk', call, entry, () =>
      this.deps.risks.evaluate(ctx, call, target),
    );
    if (!attempt.ok) return attempt.outcome;
    const verdict = attempt.value;
    switch (verdict.kind) {
      case 'no-catalog':
        return this.rejected(
          entry,
          `risk catalog for '${target.connection.provider}' is not loaded; refusing (fail closed).`,
        );
      case 'classify-denied':
        return this.rejected(entry, verdict.reason, call.args);
      case 'deny':
        return this.refused(
          {
            ...entry,
            slices_executed: verdict.executed_slices,
            risks_touched: verdict.risks_touched,
          },
          refuse.riskNotAccepted({
            missing_risks: verdict.missing_risks,
            executed_slices: verdict.executed_slices,
            hint: verdict.hint,
          }),
        );
      case 'allow':
        return {
          risks_touched: verdict.risks_touched,
          entry: {
            ...entry,
            slices_executed: verdict.executed_slices,
            risks_touched: verdict.risks_touched,
          },
        };
    }
  }

  /** Budget, rate limit and gate. Returns the entry of an allowed call. */
  private async decideBudget(
    ctx: MissionContext,
    call: CallRequest,
    classified: ClassifiedCall,
    now: Date,
  ): Promise<CallOutcome | CallAuditEntry> {
    const attempt = await this.attempt('budget', call, classified.entry, () =>
      this.deps.budget.decide(ctx, call, { risks_touched: classified.risks_touched, now }),
    );
    if (!attempt.ok) return attempt.outcome;
    const budget = attempt.value;
    if (budget.outcome === 'refused') return this.refused(classified.entry, budget.refusal);
    return {
      ...classified.entry,
      session_id: budget.session_id,
      decision: 'allowed',
      approval_id: budget.approval_id,
      remaining_budget: budget.remaining,
    };
  }

  /**
   * Runs one decision stage. A stage that throws — a classifier that is not total,
   * a store that fails under the budget — has decided nothing, so the call is
   * refused; and since every refused call has its entry (spec §8), the refusal is
   * written here, on the entry as far as the earlier stages filled it. Only the
   * stage is guarded: a failure of that audit write propagates like any other.
   */
  private async attempt<T>(
    stage: DecisionStage,
    call: CallRequest,
    entry: CallAuditEntry,
    run: () => Promise<T>,
  ): Promise<
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly outcome: CallOutcome }
  > {
    let value: T;
    try {
      value = await run();
    } catch (thrown) {
      try {
        this.deps.onStageError?.(stage, thrown, call);
      } catch {
        // The observer is a log line; the refusal and its entry do not depend on it.
      }
      return { ok: false, outcome: await this.rejected(entry, stageFailureReason(stage, thrown)) };
    }
    return { ok: true, value };
  }

  /**
   * Upstream mint and forward, then the audit entry of the allowed call.
   * Only the provider call sits in the `try`: a failure of the audit write
   * after a successful forward is not an upstream failure — it propagates,
   * and is never recorded as `upstream_error` on an action that happened.
   */
  private async forward(
    ctx: MissionContext,
    call: CallRequest,
    target: CallTarget,
    decided: CallAuditEntry,
  ): Promise<CallOutcome> {
    const t0 = this.now().getTime();
    let result: unknown;
    try {
      result = await this.deps.upstream.execute(ctx, call, target);
    } catch (e) {
      return this.failed(decided, t0, e);
    }
    const entry: CallAuditEntry = { ...decided, upstream_latency_ms: this.now().getTime() - t0 };
    await this.deps.audit.write(entry);
    return { kind: 'allowed', result, audit: entry };
  }

  /**
   * The provider failed after an allowed decision: the entry stays `allowed`
   * and records the bounded, host-built summary of the failure; the
   * provider's text leaves on the outcome only.
   */
  private async failed(decided: CallAuditEntry, t0: number, e: unknown): Promise<CallOutcome> {
    const failure = describeUpstreamFailure(e);
    const entry: CallAuditEntry = {
      ...decided,
      upstream_latency_ms: this.now().getTime() - t0,
      upstream_error: failure.summary.slice(0, UPSTREAM_ERROR_SUMMARY_MAX_LENGTH),
    };
    await this.deps.audit.write(entry);
    return { kind: 'failed', error: failure.detail, refusal: failure.refusal, audit: entry };
  }

  private baseEntry(ctx: MissionContext, call: CallRequest, now: Date): CallAuditEntry {
    // Who called is the token's holder, read from the authenticated context:
    // nothing the caller sends can change it (the agent label is the declared part).
    const attribution = tokenAttributionOf(ctx.token);
    return {
      kind: 'call',
      ts: now.toISOString(),
      mission_id: ctx.mission.id,
      token_id: attribution.token_id,
      token_kind: attribution.token_kind,
      token_holder: attribution.holder,
      session_id: ctx.session?.id ?? null,
      connection_id: null,
      resource_ref: null,
      tool: call.tool,
      arguments_hash: fingerprintArguments(call.args),
      slices_executed: [],
      risks_touched: [],
      accepted_risks_snapshot: acceptedRisksOf(ctx),
      decision: 'refused',
      refusal_code: null,
      refusal_reason: null,
      approval_id: null,
      remaining_budget: null,
      agent_label: call.agent_label,
      upstream_latency_ms: null,
      upstream_error: null,
      client_ip: call.client.ip,
      client_user_agent: call.client.user_agent,
    };
  }

  private async refused(base: CallAuditEntry, refusal: Refusal): Promise<CallOutcome> {
    const entry: CallAuditEntry = {
      ...base,
      decision: 'refused',
      refusal_code: refusal.code,
      refusal_reason: refusal.hint,
    };
    await this.deps.audit.write(entry);
    return { kind: 'refused', refusal, audit: entry };
  }

  /**
   * A structural rejection. `reason` goes to the caller as it is; the audit entry
   * keeps a copy without the argument values a plugin may have quoted in it
   * (`args`, when the reason comes from a plugin), and bounded.
   */
  private async rejected(
    base: CallAuditEntry,
    reason: string,
    args?: unknown,
  ): Promise<CallOutcome> {
    const entry: CallAuditEntry = {
      ...base,
      decision: 'refused',
      refusal_code: null,
      refusal_reason: auditReason(reason, args),
    };
    await this.deps.audit.write(entry);
    return { kind: 'rejected', reason, audit: entry };
  }
}
