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
 *   resource resolution             resource-not-in-mission (ResourceStage, P1.x authority)
 *   connection availability         connection-unavailable (this module)
 *   classify + risk decision        risk-not-accepted      (RiskStage over risk-gateway.ts)
 *   budget / rate / gate            budget-exhausted, rate-limited, approval-required (BudgetStage, P1.3)
 *   upstream mint + forward         —                      (UpstreamStage, P1.2 plugins, P1.6 door)
 *   audit                           always, exactly once   (AuditWriter, P0.3 store)
 *
 * A refused call decrements nothing and still produces an audit entry. An
 * allowed call that fails upstream keeps `decision: 'allowed'` and records
 * `upstream_error` (the decision is what the gateway did). An audit write
 * that fails propagates: no call completes without its entry.
 *
 * What is deliberately NOT here: JSON-RPC routing, `tools/list` filtering,
 * the catalog endpoint, streaming — that is the door (P1.6), which calls
 * `authenticate` then `CallPipeline.execute` and serializes the outcome with
 * `refusalToRpcError` / `rpcSuccess`.
 */

import { acceptedRisksOf, type RiskId } from '@vaubaan/shared';
import { hashArguments, type AuditWriter, type CallAuditEntry } from './audit.ts';
import { AuthError, refuse, type Refusal } from './errors.ts';
import type { CallVerdict } from './risk-gateway.ts';
import type {
  BearerKind,
  DelegationContext,
  Door,
  MissionConnection,
  MissionContext,
  MissionResource,
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
 * Identifies a raw bearer. Implemented by the door (P1.6) over the store:
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
    if ('code' in outcome) return outcome;
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

/** `mission-inactive` when the mission's status or expiry says so. */
export function checkMissionActive(ctx: MissionContext, now: Date): Refusal | null {
  const { status, expires_at } = ctx.mission;
  if (status !== 'active') {
    return refuse.missionInactive({
      status,
      reason:
        status === 'expired'
          ? `the mission expired at ${expires_at ?? 'an unknown time'}`
          : status === 'orphaned'
            ? 'the authority behind the mission vanished (share or connection revoked, creator gone)'
            : 'the mission was revoked by its creator',
    });
  }
  if (expires_at !== null && Date.parse(expires_at) <= now.getTime()) {
    return refuse.missionInactive({
      status: 'expired',
      reason: `the mission expired at ${expires_at}`,
    });
  }
  return null;
}

/** `connection-unavailable` when the connection is not `active`. */
export function checkConnectionAvailable(connection: MissionConnection): Refusal | null {
  if (connection.status === 'active') return null;
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
 * (spec §3.1). Implemented by the authority feature over the plugin's
 * knowledge of which argument carries the ref.
 */
export interface ResourceStage {
  resolve(
    ctx: MissionContext,
    call: CallRequest,
  ): Promise<{ ok: true; target: CallTarget } | { ok: false; refusal: Refusal }>;
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
 *  provider's result. The executor never sees the credential (spec §2.4). */
export interface UpstreamStage {
  execute(ctx: MissionContext, call: CallRequest, target: CallTarget): Promise<unknown>;
}

export interface CallPipelineDeps {
  readonly resources: ResourceStage;
  readonly risks: RiskStage;
  readonly budget: BudgetStage;
  readonly upstream: UpstreamStage;
  readonly audit: AuditWriter;
  /** Clock, injectable for tests. */
  readonly now?: () => Date;
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
      /** Allowed, then the provider failed. */
      readonly kind: 'failed';
      readonly error: string;
      readonly audit: CallAuditEntry;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

export class CallPipeline {
  private readonly now: () => Date;

  constructor(private readonly deps: CallPipelineDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async execute(ctx: MissionContext, call: CallRequest): Promise<CallOutcome> {
    const now = this.now();
    const base = this.baseEntry(ctx, call, now);

    const inactive = checkMissionActive(ctx, now);
    if (inactive) return this.refused(base, inactive);

    const resolved = await this.deps.resources.resolve(ctx, call);
    if (!resolved.ok) return this.refused(base, resolved.refusal);
    const { target } = resolved;
    const targeted: CallAuditEntry = {
      ...base,
      connection_id: target.connection.id,
      resource_ref: target.resource?.ref ?? null,
    };

    const unavailable = checkConnectionAvailable(target.connection);
    if (unavailable) return this.refused(targeted, unavailable);

    const verdict = await this.deps.risks.evaluate(ctx, call, target);
    switch (verdict.kind) {
      case 'no-catalog':
        return this.rejected(
          targeted,
          `risk catalog for '${target.connection.provider}' is not loaded; refusing (fail closed).`,
        );
      case 'classify-denied':
        return this.rejected(targeted, verdict.reason);
      case 'deny':
        return this.refused(
          { ...targeted, slices_executed: verdict.executed_slices },
          refuse.riskNotAccepted({
            missing_risks: verdict.missing_risks,
            executed_slices: verdict.executed_slices,
            hint: verdict.hint,
          }),
        );
      case 'allow':
        break;
    }

    const classified: CallAuditEntry = {
      ...targeted,
      slices_executed: verdict.executed_slices,
      risks_touched: verdict.risks_touched,
    };

    const budget = await this.deps.budget.decide(ctx, call, {
      risks_touched: verdict.risks_touched,
      now,
    });
    if (budget.outcome === 'refused') return this.refused(classified, budget.refusal);

    const decided: CallAuditEntry = {
      ...classified,
      session_id: budget.session_id,
      decision: 'allowed',
      approval_id: budget.approval_id,
      remaining_budget: budget.remaining,
    };

    const t0 = Date.now();
    try {
      const result = await this.deps.upstream.execute(ctx, call, target);
      const entry: CallAuditEntry = { ...decided, upstream_latency_ms: Date.now() - t0 };
      await this.deps.audit.write(entry);
      return { kind: 'allowed', result, audit: entry };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const entry: CallAuditEntry = {
        ...decided,
        upstream_latency_ms: Date.now() - t0,
        upstream_error: error,
      };
      await this.deps.audit.write(entry);
      return { kind: 'failed', error, audit: entry };
    }
  }

  private baseEntry(ctx: MissionContext, call: CallRequest, now: Date): CallAuditEntry {
    return {
      kind: 'call',
      ts: now.toISOString(),
      mission_id: ctx.mission.id,
      session_id: ctx.session?.id ?? null,
      connection_id: null,
      resource_ref: null,
      tool: call.tool,
      arguments_hash: hashArguments(call.args),
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

  private async rejected(base: CallAuditEntry, reason: string): Promise<CallOutcome> {
    const entry: CallAuditEntry = {
      ...base,
      decision: 'refused',
      refusal_code: null,
      refusal_reason: reason,
    };
    await this.deps.audit.write(entry);
    return { kind: 'rejected', reason, audit: entry };
  }
}
