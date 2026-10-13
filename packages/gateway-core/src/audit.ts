/**
 * Audit model — one immutable entry per MCP call (allowed or refused) and per
 * administrative act.
 *
 * Spec: docs/spec/vaubaan-gateway.md §8 (fields), §6 ("Immutable audit",
 * "No secret in logs": arguments are hashed, never stored in clear);
 * docs/spec/gateway-risk-model.md §12 (shape of the risk fields).
 *
 * This module owns the entry shape and the `AuditWriter` contract. The
 * persistent writer (SQLite, append-only triggers) lives in the store of the
 * application (feature P0.3) and implements `AuditWriter`; `MemoryAuditWriter`
 * serves tests. The interface name and the `write(entry)` signature are the
 * contract between the two and must stay stable.
 */

import { createHash } from 'node:crypto';
import type { AuditDecision, RefusalCode, RiskId, Slice } from '@vaubaan/shared';

export type { AuditDecision } from '@vaubaan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Call entries
// ─────────────────────────────────────────────────────────────────────────────

export interface CallAuditEntry {
  readonly kind: 'call';
  /** ISO timestamp of the decision. */
  readonly ts: string;
  readonly mission_id: string;
  /** Null when the call was refused before the session was touched. */
  readonly session_id: string | null;
  /** Connection and resource the call targeted, when resolved. */
  readonly connection_id: string | null;
  readonly resource_ref: string | null;
  readonly tool: string;
  /** `hashArguments(args)`: sha256 truncated to 16 hex characters. Never the
   *  arguments themselves. */
  readonly arguments_hash: string;
  /** Slices the plugin emitted for the call (empty when refused before
   *  classification). */
  readonly slices_executed: readonly Slice[];
  /** Risks those slices intersected in the catalog. */
  readonly risks_touched: readonly RiskId[];
  /** Snapshot of the mission's accepted risks at call time, for forensic
   *  reproducibility: the mission may be re-issued or revoked later. */
  readonly accepted_risks_snapshot: readonly RiskId[];
  /** Decision of the gateway (`AuditDecision` in `@vaubaan/shared`). An
   *  upstream failure after an allow stays `allowed` with `upstream_error`
   *  set: the decision is what the gateway did; the outcome is what the
   *  provider did. */
  readonly decision: AuditDecision;
  readonly refusal_code: RefusalCode | null;
  /** The refusal's hint, or the structural reason for a refusal that has no
   *  code (unknown tool, classifier denial, catalog missing). */
  readonly refusal_reason: string | null;
  /** The approval consumed by this call, if any (spec §3.5). */
  readonly approval_id: string | null;
  /** Remaining quota per risk after the call, for the risks the call touched.
   *  Null when the budget was not consulted. */
  readonly remaining_budget: Readonly<Record<RiskId, number>> | null;
  /** Free-form attribution label sent by the agent; no effect on
   *  authorization. */
  readonly agent_label: string | null;
  readonly upstream_latency_ms: number | null;
  /** Set when an allowed call failed upstream; the business effect did not
   *  happen (or is unknown). */
  readonly upstream_error: string | null;
  readonly client_ip: string | null;
  readonly client_user_agent: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Administrative entries
// ─────────────────────────────────────────────────────────────────────────────

/** Spec §8: "connection, share, revocation, issuance, extension, reset,
 *  approval, rotation, delegation granted or revoked, configuration change". */
export type AdminAct =
  | 'connection-created'
  | 'connection-reconnected'
  /** A connect attempt the host refused because the installation could not be
   *  bound to the connecting human (nothing was stored). */
  | 'connection-refused'
  | 'connection-transferred'
  | 'connection-revoked'
  | 'share-created'
  | 'share-revoked'
  | 'mission-issued'
  | 'mission-rotated'
  | 'mission-revoked'
  | 'mission-closed'
  | 'budget-extended'
  | 'period-reset'
  | 'expiry-extended'
  | 'gate-opened'
  | 'approval-granted'
  | 'request-refused'
  | 'delegation-granted'
  | 'delegation-revoked'
  | 'config-changed';

export type AdminObjectType =
  | 'connection'
  | 'share'
  | 'mission'
  | 'request'
  | 'delegation'
  | 'instance-config';

export interface AdminAuditEntry {
  readonly kind: 'admin';
  readonly ts: string;
  /** The human behind the act, always a user (a delegated client acts on
   *  behalf of one). */
  readonly user_id: string;
  readonly act: AdminAct;
  readonly object: { readonly type: AdminObjectType; readonly id: string };
  /** Previous and new state, when meaningful; `null` when not. Never a secret. */
  readonly before: unknown;
  readonly after: unknown;
  /** Set when the act came through the management door (spec §4.1 bis). */
  readonly delegated_client_id: string | null;
}

export type AuditEntry = CallAuditEntry | AdminAuditEntry;

// ─────────────────────────────────────────────────────────────────────────────
// Writer contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable contract with the store's writer (feature P0.3). A writer must not
 * swallow failures: the pipeline treats a rejected `write` as an internal
 * error, so a call never completes without its audit entry.
 */
export interface AuditWriter {
  write(entry: AuditEntry): Promise<void>;
}

/** sha256 of the JSON-serialized arguments, truncated to 16 hex characters.
 *  Unchanged since v4 (audit rows stay comparable across the pivot). Not a
 *  canonical fingerprint: key order matters. The canonical fingerprint that
 *  binds approvals is feature P1.3's. */
export function hashArguments(args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(args ?? {}))
    .digest('hex')
    .slice(0, 16);
}

/** In-memory writer for tests. */
export class MemoryAuditWriter implements AuditWriter {
  readonly entries: AuditEntry[] = [];

  async write(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  get calls(): CallAuditEntry[] {
    return this.entries.filter((e): e is CallAuditEntry => e.kind === 'call');
  }

  get admin(): AdminAuditEntry[] {
    return this.entries.filter((e): e is AdminAuditEntry => e.kind === 'admin');
  }
}
