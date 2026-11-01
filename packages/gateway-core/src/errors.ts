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

import type { ConnectionLoss } from './types.ts';
import {
  isRefusalCode,
  type ConnectionStatus,
  type JsonRpcError,
  type JsonRpcSuccess,
  type MissionStatus,
  type RateLimit,
  type RefusalCode,
  type RiskId,
  type Slice,
} from '@vaubaan/shared';
import type { BearerKind, ConnectionOwner, Door } from './types.ts';

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
  readonly refusal_id?: string;
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
  /** The resource set whose budget is spent, when the connection has several (risk model §4.7). */
  readonly resource_set?: string;
}

export interface ApprovalRequiredRefusal extends RefusalBase<'approval-required'> {
  /** The first of `risk_ids`. */
  readonly risk_id: RiskId;
  /**
   * Every risk of the call that waits for the creator's approval. One request
   * covers them all: granting it approves the call (spec §3.5).
   */
  readonly risk_ids: readonly RiskId[];
  /** Fingerprint of the call's arguments the approval will be bound to. */
  readonly fingerprint: string;
  /** Where the mission creator grants or refuses this precise action. */
  readonly approval_url: string;
  /** ISO expiry of the approval request: unanswered by then, it is closed. */
  readonly expires_at: string;
  /** How long a granted approval stays usable: the identical replay must come
   *  within this delay after the grant (operator-configured). */
  readonly approval_valid_seconds: number;
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
  readonly limit: RateLimit;
  readonly retry_after_seconds: number;
  /** The resource set whose rate limit is reached, when the connection has several. */
  readonly resource_set?: string;
}

/** Statuses that make a connection unusable. An `unowned` connection (its
 *  owning group emptied) keeps serving its missions until someone reconnects
 *  or revokes it (spec §2). */
export const UNAVAILABLE_CONNECTION_STATUSES = [
  'expired',
  'revoked',
] as const satisfies readonly ConnectionStatus[];
export type UnavailableConnectionStatus = (typeof UNAVAILABLE_CONNECTION_STATUSES)[number];

export function isUnavailableConnectionStatus(
  status: ConnectionStatus,
): status is UnavailableConnectionStatus {
  return (UNAVAILABLE_CONNECTION_STATUSES as readonly ConnectionStatus[]).includes(status);
}

export interface ConnectionUnavailableRefusal extends RefusalBase<'connection-unavailable'> {
  readonly connection: { readonly id: string; readonly name: string };
  readonly status: UnavailableConnectionStatus;
  /** Who can reconnect: the owner (user email or group name). */
  readonly owner: Pick<ConnectionOwner, 'kind' | 'display'>;
}

export interface ConnectionRevokedRefusal extends RefusalBase<'connection-revoked'> {
  readonly connection: { readonly id: string; readonly name: string };
  /** `connection-revoked`: removed by its owner; `access-withdrawn`: the mission's creator lost it. */
  readonly cause: ConnectionLoss;
  /** True when nothing brings it back: a new mission is needed for another account. */
  readonly final: boolean;
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
  | ConnectionRevokedRefusal
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

/** What the agent can expect next for each inactive mission status. Keyed
 *  by status so a new status fails to compile until it has its sentence. */
const INACTIVE_MISSION_NEXT_STEP: Readonly<Record<Exclude<MissionStatus, 'active'>, string>> = {
  expired: 'Only the mission creator can extend it.',
  orphaned:
    'The authority behind it is missing. It serves calls again, with this same token, if that authority comes back (a share made again, the creator back in their group); a revoked account never comes back. A request opened before the mission was orphaned can be granted only until it expires; after that, your next refused call opens a new one. Report to the human rather than retrying in a loop.',
  revoked: 'A new mission must be issued.',
};

/** Where each kind of bearer IS accepted (spec §4.1: the refusal names "the door that
 *  would accept it"). Keyed by kind, so a new kind fails to compile until it has its line. */
const ACCEPTED_AT: Readonly<Record<BearerKind, string>> = {
  'mission-token': 'A mission-token opens the execution door only.',
  'delegated-token': 'A delegated-token opens the management door only.',
  'human-session': 'A human-session opens the web interface only, never an MCP door.',
};

export const refuse = {
  riskNotAccepted(input: {
    missing_risks: readonly RiskId[];
    executed_slices: readonly Slice[];
    /** The hint composed by the policy engine (`evaluateCall`), which owns
     *  the wording of this refusal: it knows which slices were executed and
     *  why nothing, or not enough, matched. */
    hint: string;
  }): RiskNotAcceptedRefusal {
    return {
      code: 'risk-not-accepted',
      missing_risks: input.missing_risks,
      executed_slices: input.executed_slices,
      hint: input.hint,
    };
  },

  budgetExhausted(input: {
    risk_id: RiskId;
    quota: number;
    consumed: number;
    period_end: string | null;
    claim_url: string;
    /** "resource set 2", when the connection has several sets. */
    resource_set?: string;
  }): BudgetExhaustedRefusal {
    const next = input.period_end
      ? `The quota reloads at ${input.period_end}.`
      : 'This mission has no next period; only a claim can reopen this risk.';
    const where = input.resource_set ? ` in ${input.resource_set}` : '';
    return {
      code: 'budget-exhausted',
      risk_id: input.risk_id,
      quota: input.quota,
      consumed: input.consumed,
      period_end: input.period_end,
      claim_url: input.claim_url,
      ...(input.resource_set ? { resource_set: input.resource_set } : {}),
      hint: `Budget exhausted for '${input.risk_id}'${where}: ${input.consumed}/${input.quota} actions used this period. ${next} A claim for the mission creator is open at ${input.claim_url}. ${HAND_TO_HUMAN}`,
    };
  },

  approvalRequired(input: {
    risk_id: RiskId;
    /** Every gated risk the request covers; `[risk_id]` when absent. */
    risk_ids?: readonly RiskId[];
    fingerprint: string;
    approval_url: string;
    expires_at: string;
    approval_valid_seconds: number;
  }): ApprovalRequiredRefusal {
    const riskIds = input.risk_ids && input.risk_ids.length > 0 ? input.risk_ids : [input.risk_id];
    const [only] = riskIds;
    const asked =
      riskIds.length === 1
        ? `'${only}' requires the mission creator's approval for each action.`
        : `This call touches ${riskIds.length} risks that each require the mission creator's approval: ${riskIds.map((r) => `'${r}'`).join(', ')}. One approval request covers the whole call.`;
    return {
      code: 'approval-required',
      risk_id: input.risk_id,
      risk_ids: riskIds,
      fingerprint: input.fingerprint,
      approval_url: input.approval_url,
      expires_at: input.expires_at,
      approval_valid_seconds: input.approval_valid_seconds,
      hint: `${asked} Nothing was executed and nothing is held. An approval request is open at ${input.approval_url} until ${input.expires_at}. Once granted, replay this call with the same tool and exactly the same arguments within ${input.approval_valid_seconds}s of the grant: the approval is used once, and any change of the arguments asks again. ${HAND_TO_HUMAN}`,
    };
  },

  resourceNotInMission(input: {
    cited_ref: string;
    connection: { id: string; name: string };
    allowed_resources: readonly { ref: string; env: string | null; display_name: string | null }[];
    /** The mission was issued on the whole connection (resources found later included). */
    reaches_later_resources?: boolean;
  }): ResourceNotInMissionRefusal {
    const allowed =
      input.allowed_resources.length === 0
        ? 'no resource'
        : input.allowed_resources.map((r) => r.ref).join(', ');
    if (input.reaches_later_resources === true) {
      return {
        code: 'resource-not-in-mission',
        cited_ref: input.cited_ref,
        connection: { id: input.connection.id, name: input.connection.name },
        allowed_resources: input.allowed_resources,
        hint: `Resource '${input.cited_ref}' is not reached on connection '${input.connection.name}'. This mission reaches the whole account except the resources its owner hid or that are no longer found: ${allowed} today. A resource created through the gateway is reached right after its creation; one created elsewhere once the account's owner refreshes its resources.`,
      };
    }
    return {
      code: 'resource-not-in-mission',
      cited_ref: input.cited_ref,
      connection: { id: input.connection.id, name: input.connection.name },
      allowed_resources: input.allowed_resources,
      hint: `Resource '${input.cited_ref}' is not part of this mission on connection '${input.connection.name}'. The mission may touch: ${allowed}. A resource this mission creates through the gateway is reached right after its creation. For one created elsewhere, use one of these refs, or ask the mission creator to add the resource: they edit the mission, your key stays the same and your next call reaches it.`,
    };
  },

  rateLimited(input: {
    risk_id: RiskId;
    limit: RateLimit;
    retry_after_seconds: number;
    /** "resource set 2", when the connection has several sets. */
    resource_set?: string;
  }): RateLimitedRefusal {
    return {
      code: 'rate-limited',
      risk_id: input.risk_id,
      limit: { max: input.limit.max, window_seconds: input.limit.window_seconds },
      retry_after_seconds: input.retry_after_seconds,
      ...(input.resource_set ? { resource_set: input.resource_set } : {}),
      hint: `Rate limit reached for '${input.risk_id}'${input.resource_set ? ` in ${input.resource_set}` : ''}: ${input.limit.max} actions per ${input.limit.window_seconds}s. Wait ${input.retry_after_seconds}s before retrying. The quota is not consumed by this refusal.`,
    };
  },

  connectionUnavailable(input: {
    connection: { id: string; name: string };
    status: UnavailableConnectionStatus;
    owner: Pick<ConnectionOwner, 'kind' | 'display'>;
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

  connectionRevoked(input: {
    connection: { id: string; name: string };
    cause: ConnectionLoss;
  }): ConnectionRevokedRefusal {
    const name = input.connection.name;
    const final = input.cause === 'connection-revoked';
    const why = final
      ? `Account '${name}' was removed from this gateway by its owner; it never comes back to this mission.`
      : `The creator of this mission no longer has access to account '${name}' (its owner withdrew it, or the creator left the team that held it). Calls through it are refused while it is so; this same token works on it again if the access is given back.`;
    const next = final
      ? 'To use that service again, ask the mission creator to issue a new mission for the account that replaces it.'
      : 'Ask the mission creator to get the access back, or to issue a new mission for another account.';
    return {
      code: 'connection-revoked',
      connection: { id: input.connection.id, name },
      cause: input.cause,
      final,
      hint: `${why} The mission still serves its other accounts: keep using them. ${next} Do not retry calls through '${name}'.`,
    };
  },

  missionInactive(input: {
    status: Exclude<MissionStatus, 'active'>;
    reason: string;
  }): MissionInactiveRefusal {
    const next = INACTIVE_MISSION_NEXT_STEP[input.status];
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
      hint: `A ${input.presented} cannot open the ${input.door} door; it expects a ${input.expected}. ${ACCEPTED_AT[input.presented]} Credentials never cross over: use the ${input.expected} issued for this door.`,
    };
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC mapping
// ─────────────────────────────────────────────────────────────────────────────

/** JSON-RPC error code carried by every refusal (and by upstream errors). */
export const REFUSAL_RPC_CODE = -32603;
/** JSON-RPC error code and HTTP status of an `AuthError` (unknown or malformed bearer). */
export const AUTH_REQUIRED_RPC_CODE = -32001;
export const AUTH_REQUIRED_HTTP_STATUS = 401;

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

/**
 * Why a mission token whose secret was proven no longer authenticates (spec §0
 * "Mission token": a token is rotated or revoked on its own, and a member
 * token stops working when the member is removed or deactivated). These are
 * NOT refusal codes: the mission may well be serving its other holders, and a
 * refusal presupposes a credential that authenticates. The door answers 401
 * and states the reason in the error's `data`, so the agent can tell the human
 * what happened instead of reporting "unknown bearer".
 */
export const AUTH_FAILURE_REASONS = [
  /** The holder generated a newer token: this one was replaced. */
  'token-rotated',
  /** The token was revoked, by its holder or by the mission creator. */
  'token-revoked',
  /** The token's holder is no longer a member of the mission. */
  'holder-removed',
  /** The token's holder was deactivated on this instance. */
  'holder-deactivated',
] as const;
export type AuthFailureReason = (typeof AUTH_FAILURE_REASONS)[number];

/** What the agent is told, per reason. Keyed by reason so a new one fails to
 *  compile until it has its sentence. */
export const AUTH_FAILURE_MESSAGES: Readonly<Record<AuthFailureReason, string>> = {
  'token-rotated':
    'this mission token was replaced by a newer one of the same holder. Use the newer token; if you do not have it, ask the human who gave you this one.',
  'token-revoked':
    'this mission token was revoked. The mission may still be running for its other holders; ask the human who gave you this token for a new one.',
  'holder-removed':
    'the holder of this mission token is no longer a member of the mission. Stop calling with this token and report to the human.',
  'holder-deactivated':
    'the holder of this mission token was deactivated on this instance. Stop calling with this token and report to the human.',
};

/** Malformed, unknown, revoked or expired bearer: the door answers 401 with
 *  `-32001`. Not a refusal: a refusal presupposes an identified credential.
 *  `reason` is set only when the secret was proven and the token is known to
 *  have stopped working (`AUTH_FAILURE_REASONS`). */
export class AuthError extends GatewayError {
  constructor(
    message: string,
    readonly reason: AuthFailureReason | null = null,
  ) {
    super(message, AUTH_REQUIRED_RPC_CODE, AUTH_REQUIRED_HTTP_STATUS);
    this.name = 'AuthError';
  }

  /** The 401 of a token that authenticated once and no longer does. */
  static tokenStopped(reason: AuthFailureReason): AuthError {
    return new AuthError(AUTH_FAILURE_MESSAGES[reason], reason);
  }
}
