/**
 * Structured refusals and JSON-RPC error builders.
 *
 * Spec: docs/spec/vaubaan-gateway.md §4.1 (structured refusals, each with an
 * agent-readable `hint`), §6 (separation of the three credentials), §10
 * ("structured refusals: every code, every field, the `hint`").
 *
 * A refusal is data, not an exception: the pipeline returns it, the door
 * serializes it. Every refusal carries its `code`, the fields the spec lists
 * for that code, and a `hint` telling the agent what to do, in particular to
 * hand a request URL to a human and never to work around it.
 *
 * JSON-RPC mapping (unchanged since v4): a refusal is a `-32603` error whose
 * `data` is the refusal object. Standard codes for reference:
 *   -32700 Parse error, -32600 Invalid Request, -32601 Method not found,
 *   -32602 Invalid params, -32603 Internal error (refusals, upstream errors),
 *   -32001 Auth required (Vaubaan-specific, unknown or malformed bearer).
 */

import {
  isRefusalCode,
  type ConnectionStatus,
  type JsonRpcError,
  type JsonRpcSuccess,
  type MissionStatus,
  type RefusalCode,
  type RiskId,
  type Slice,
} from '@vaubaan/shared';
import type { BearerKind, Door } from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Refusal shapes — one per code
// ─────────────────────────────────────────────────────────────────────────────

interface RefusalBase<C extends RefusalCode> {
  readonly code: C;
  /** Agent-readable instruction. Never empty. */
  readonly hint: string;
}

/** Unchanged since v4: missing risks and the slices the call executed. */
export interface RiskNotAcceptedRefusal extends RefusalBase<'risk-not-accepted'> {
  readonly missing_risks: readonly RiskId[];
  readonly executed_slices: readonly Slice[];
}

export interface BudgetExhaustedRefusal extends RefusalBase<'budget-exhausted'> {
  readonly risk_id: RiskId;
  /** Quota for the period. */
  readonly quota: number;
  /** Actions consumed in the current period. */
  readonly consumed: number;
  /** ISO end of the current period, or null for a one-off mission (no
   *  next period: only a claim can reopen the risk). */
  readonly period_end: string | null;
  /** Where the mission creator can reset or extend. */
  readonly claim_url: string;
}

export interface ApprovalRequiredRefusal extends RefusalBase<'approval-required'> {
  readonly risk_id: RiskId;
  /** Fingerprint of the call's arguments the approval will be bound to. */
  readonly fingerprint: string;
  /** Where the mission creator grants or refuses this precise action. */
  readonly approval_url: string;
  /** ISO expiry of the approval request. */
  readonly expires_at: string;
}

export interface ResourceNotInMissionRefusal extends RefusalBase<'resource-not-in-mission'> {
  /** The ref the arguments cited. */
  readonly cited_ref: string;
  readonly connection: { readonly id: string; readonly name: string };
  /** The resources the mission may touch on that connection. */
  readonly allowed_resources: readonly {
    readonly ref: string;
    readonly env: string | null;
    readonly display_name: string | null;
  }[];
}

export interface RateLimitedRefusal extends RefusalBase<'rate-limited'> {
  readonly risk_id: RiskId;
  readonly limit: { readonly max: number; readonly window_seconds: number };
  readonly retry_after_seconds: number;
}

export interface ConnectionUnavailableRefusal extends RefusalBase<'connection-unavailable'> {
  readonly connection: { readonly id: string; readonly name: string };
  readonly status: Exclude<ConnectionStatus, 'active'>;
  /** Who can reconnect: the owner (user email or group name). */
  readonly owner: { readonly kind: 'user' | 'group'; readonly display: string };
}

export interface MissionInactiveRefusal extends RefusalBase<'mission-inactive'> {
  readonly status: Exclude<MissionStatus, 'active'>;
  readonly reason: string;
}

export interface WrongCredentialKindRefusal extends RefusalBase<'wrong-credential-kind'> {
  readonly door: Door;
  readonly presented: BearerKind;
  readonly expected: BearerKind;
}

export type Refusal =
  | RiskNotAcceptedRefusal
  | BudgetExhaustedRefusal
  | ApprovalRequiredRefusal
  | ResourceNotInMissionRefusal
  | RateLimitedRefusal
  | ConnectionUnavailableRefusal
  | MissionInactiveRefusal
  | WrongCredentialKindRefusal;

/** Narrow a refusal to one code. */
export type RefusalOf<C extends RefusalCode> = Extract<Refusal, { code: C }>;

/** Type guard: an object is a refusal iff it carries a known code and a hint. */
export function isRefusal(value: unknown): value is Refusal {
  if (!value || typeof value !== 'object') return false;
  const v = value as { code?: unknown; hint?: unknown };
  return (
    typeof v.code === 'string' &&
    isRefusalCode(v.code) &&
    typeof v.hint === 'string' &&
    v.hint.length > 0
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Builders — each composes the agent-readable hint
// ─────────────────────────────────────────────────────────────────────────────

const HAND_TO_HUMAN =
  'Hand this URL to the human steering you; do not retry in a loop and do not try to work around the refusal.';

export const refuse = {
  riskNotAccepted(input: {
    missing_risks: readonly RiskId[];
    executed_slices: readonly Slice[];
    /** Optional hint computed by the policy engine; a default is composed
     *  when absent. */
    hint?: string;
  }): RiskNotAcceptedRefusal {
    return {
      code: 'risk-not-accepted',
      missing_risks: input.missing_risks,
      executed_slices: input.executed_slices,
      hint:
        input.hint ??
        `This mission does not accept [${input.missing_risks.join(', ')}]. Ask the mission creator to issue a mission that accepts these risks, or restrict the operation to what the mission accepts.`,
    };
  },

  budgetExhausted(input: {
    risk_id: RiskId;
    quota: number;
    consumed: number;
    period_end: string | null;
    claim_url: string;
  }): BudgetExhaustedRefusal {
    const next = input.period_end
      ? `The quota reloads at ${input.period_end}.`
      : 'This mission has no next period; only a claim can reopen this risk.';
    return {
      code: 'budget-exhausted',
      risk_id: input.risk_id,
      quota: input.quota,
      consumed: input.consumed,
      period_end: input.period_end,
      claim_url: input.claim_url,
      hint: `Budget exhausted for '${input.risk_id}': ${input.consumed}/${input.quota} actions used this period. ${next} A claim for the mission creator is open at ${input.claim_url}. ${HAND_TO_HUMAN}`,
    };
  },

  approvalRequired(input: {
    risk_id: RiskId;
    fingerprint: string;
    approval_url: string;
    expires_at: string;
  }): ApprovalRequiredRefusal {
    return {
      code: 'approval-required',
      risk_id: input.risk_id,
      fingerprint: input.fingerprint,
      approval_url: input.approval_url,
      expires_at: input.expires_at,
      hint: `'${input.risk_id}' requires the mission creator's approval for each action. Nothing was executed. An approval request is open at ${input.approval_url} until ${input.expires_at}. Once granted, replay this call with exactly the same arguments; any change asks again. ${HAND_TO_HUMAN}`,
    };
  },

  resourceNotInMission(input: {
    cited_ref: string;
    connection: { id: string; name: string };
    allowed_resources: readonly { ref: string; env: string | null; display_name: string | null }[];
  }): ResourceNotInMissionRefusal {
    const allowed =
      input.allowed_resources.length === 0
        ? 'no resource'
        : input.allowed_resources.map((r) => r.ref).join(', ');
    return {
      code: 'resource-not-in-mission',
      cited_ref: input.cited_ref,
      connection: { id: input.connection.id, name: input.connection.name },
      allowed_resources: input.allowed_resources,
      hint: `Resource '${input.cited_ref}' is not part of this mission on connection '${input.connection.name}'. The mission may touch: ${allowed}. Use one of these refs, or ask the mission creator to add the resource.`,
    };
  },

  rateLimited(input: {
    risk_id: RiskId;
    limit: { max: number; window_seconds: number };
    retry_after_seconds: number;
  }): RateLimitedRefusal {
    return {
      code: 'rate-limited',
      risk_id: input.risk_id,
      limit: { max: input.limit.max, window_seconds: input.limit.window_seconds },
      retry_after_seconds: input.retry_after_seconds,
      hint: `Rate limit reached for '${input.risk_id}': ${input.limit.max} actions per ${input.limit.window_seconds}s. Wait ${input.retry_after_seconds}s before retrying. The quota is not consumed by this refusal.`,
    };
  },

  connectionUnavailable(input: {
    connection: { id: string; name: string };
    status: Exclude<ConnectionStatus, 'active'>;
    owner: { kind: 'user' | 'group'; display: string };
  }): ConnectionUnavailableRefusal {
    const who =
      input.owner.kind === 'group'
        ? `a member of group '${input.owner.display}'`
        : `its owner ${input.owner.display}`;
    return {
      code: 'connection-unavailable',
      connection: { id: input.connection.id, name: input.connection.name },
      status: input.status,
      owner: { kind: input.owner.kind, display: input.owner.display },
      hint: `Connection '${input.connection.name}' is ${input.status}; every call through it fails until ${who} reconnects it. Contact them; nothing you can do from here fixes it.`,
    };
  },

  missionInactive(input: {
    status: Exclude<MissionStatus, 'active'>;
    reason: string;
  }): MissionInactiveRefusal {
    const next =
      input.status === 'expired'
        ? 'Only the mission creator can extend it.'
        : input.status === 'orphaned'
          ? 'The authority behind it vanished; the creator or a connection owner must close it and issue a new one.'
          : 'A new mission must be issued.';
    return {
      code: 'mission-inactive',
      status: input.status,
      reason: input.reason,
      hint: `This mission is ${input.status}: ${input.reason}. ${next} Stop calling with this token and report to the human.`,
    };
  },

  wrongCredentialKind(input: {
    door: Door;
    presented: BearerKind;
    expected: BearerKind;
  }): WrongCredentialKindRefusal {
    return {
      code: 'wrong-credential-kind',
      door: input.door,
      presented: input.presented,
      expected: input.expected,
      hint: `A ${input.presented} cannot open the ${input.door} door; it expects a ${input.expected}. Credentials never cross over: use the ${input.expected} issued for this door.`,
    };
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC mapping
// ─────────────────────────────────────────────────────────────────────────────

/** JSON-RPC error code carried by every refusal (and by upstream errors). */
export const REFUSAL_RPC_CODE = -32603;

export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const err: JsonRpcError = {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
  if (data !== undefined) err.error.data = data;
  return err;
}

export function rpcSuccess(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

/** A refusal as a JSON-RPC error: `-32603`, message naming the code, the
 *  whole refusal (fields and hint) in `data`. */
export function refusalToRpcError(id: string | number | null, refusal: Refusal): JsonRpcError {
  return rpcError(id, REFUSAL_RPC_CODE, `Vaubaan refused the call: ${refusal.code}`, refusal);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exceptions for the transport layer (not refusals)
// ─────────────────────────────────────────────────────────────────────────────

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** Malformed, unknown, revoked or expired bearer: the door answers 401 with
 *  `-32001`. Not a refusal: a refusal presupposes an identified credential. */
export class AuthError extends GatewayError {
  constructor(message: string) {
    super(message, -32001, 401);
    this.name = 'AuthError';
  }
}
