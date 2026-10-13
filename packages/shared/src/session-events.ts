/**
 * Session event details — the one contract between the writers of a session
 * event and its readers (spec §3.3 "the session and the remaining budget",
 * §3.4 "the creator sees the session history").
 *
 * An event is stored as a `kind` column and a JSON `details` object. The key
 * names below are the stored ones: renaming one is a data migration, not a
 * refactor. Writers build `{ kind, details }` through `SessionEventDetails`;
 * readers get it back from `parseEventDetails`, the only place that reads
 * stored details.
 *
 * Every kind of `SessionEventKind` has a details shape here; `parseEventDetails`
 * answers `null` for a kind it does not know (a later version's).
 */
import {
  isGate,
  type Gate,
  type Iso8601,
  type RequestKind,
  type SessionEventKind,
} from './domain.ts';
import { isRefusalCode, type RefusalCode } from './refusal.ts';
import type { RiskId } from './risk.ts';

/** What every call event carries, allowed or refused. */
interface CallEventDetails {
  readonly tool: string;
  readonly fingerprint: string;
  /** Every risk the call touches. */
  readonly risk_ids: readonly RiskId[];
  /** Free-form agent label copied from the call; attribution only. */
  readonly agent_label: string | null;
}

export interface CallAllowedEventDetails extends CallEventDetails {
  /** Remaining quota per touched risk, once the call is counted. */
  readonly remaining: Readonly<Record<RiskId, number>>;
  /** The approvals the call consumed. */
  readonly approval_ids: readonly string[];
}

export interface CallRefusedEventDetails extends CallEventDetails {
  readonly refusal_code: RefusalCode;
  /** The request the refusal points to; `null` when it asks nothing of the creator. */
  readonly request_id: string | null;
}

/** A claim or an approval request dropped in the creator's inbox. */
export interface RequestDroppedEventDetails {
  readonly request_id: string;
  readonly request_kind: RequestKind;
  readonly tool: string;
  readonly fingerprint: string;
}

export const REQUEST_CLOSED_STATES = ['refused', 'expired'] as const;
export type RequestClosedState = (typeof REQUEST_CLOSED_STATES)[number];

/** A request the creator refused, or that expired unanswered. */
export interface RequestClosedEventDetails {
  readonly request_id: string;
  readonly request_kind: RequestKind;
  readonly state: RequestClosedState;
}

export type RequestEventDetails = RequestDroppedEventDetails | RequestClosedEventDetails;

/** A granted claim "reset the period": every counter of the period back to zero. */
export interface ResetEventDetails {
  readonly request_id: string;
  readonly period_start: Iso8601;
  /** `null` for a one-off mission: its single period never ends. */
  readonly period_end: Iso8601 | null;
  /** Actions given back, per risk. */
  readonly credits: Readonly<Record<RiskId, number>>;
}

/** A granted claim "extend the quota": `amount` actions given back on one risk. */
export interface QuotaExtensionEventDetails {
  readonly request_id: string;
  readonly dimension: 'quota';
  readonly amount: number;
  readonly period_start: Iso8601;
  readonly period_end: Iso8601 | null;
  readonly credits: Readonly<Record<RiskId, number>>;
}

/** A granted claim "extend the expiry" of the mission. */
export interface ExpiryExtensionEventDetails {
  readonly request_id: string;
  readonly dimension: 'expiry';
  /** `null` when the mission had no expiry. */
  readonly expires_at_before: Iso8601 | null;
  readonly expires_at: Iso8601;
}

export type ExtensionEventDetails = QuotaExtensionEventDetails | ExpiryExtensionEventDetails;

/**
 * A granted approval request (spec §3.5): one approval, bound to the call the
 * creator read. The arguments are never here, only their fingerprint.
 */
export interface ApprovalEventDetails {
  readonly request_id: string;
  readonly approval_id: string;
  readonly tool: string;
  readonly fingerprint: string;
  /** The first identical replay consumes the approval before this instant. */
  readonly expires_at: Iso8601;
}

/**
 * The creator opened the gate of one risk "for the rest of the period" (spec
 * §3.5): the risk reads `auto` for calls of the period starting at
 * `period_start`, and `approval` again from `period_end`. The risk is the
 * event's own `risk_id` column.
 */
export interface GateOpenedEventDetails {
  readonly request_id: string;
  readonly period_start: Iso8601;
  /** Always an instant: a mission with a single, endless period has no "rest of the period". */
  readonly period_end: Iso8601;
}

/**
 * The creator edited the gate of one risk on the mission itself. Recorded on
 * the session because it ends an opening granted earlier in the period: the
 * latest of the two events decides.
 */
export interface GateChangedEventDetails {
  readonly gate: Gate;
  readonly gate_before: Gate;
}

export interface RotationEventDetails {
  readonly token_prefix: string;
}

export interface RevocationEventDetails {
  readonly tokens_revoked: number;
}

/** The details of each event kind that has a writer. */
export interface SessionEventDetailsByKind {
  readonly 'call-allowed': CallAllowedEventDetails;
  readonly 'call-refused': CallRefusedEventDetails;
  readonly request: RequestEventDetails;
  readonly extension: ExtensionEventDetails;
  readonly reset: ResetEventDetails;
  readonly approval: ApprovalEventDetails;
  readonly 'gate-opened': GateOpenedEventDetails;
  readonly 'gate-changed': GateChangedEventDetails;
  readonly rotation: RotationEventDetails;
  readonly revocation: RevocationEventDetails;
}

export type DetailedSessionEventKind = keyof SessionEventDetailsByKind & SessionEventKind;

/** A kind and the details that go with it: what a writer builds and a reader parses. */
export type SessionEventDetails = {
  readonly [K in DetailedSessionEventKind]: {
    readonly kind: K;
    readonly details: SessionEventDetailsByKind[K];
  };
}[DetailedSessionEventKind];

// ─────────────────────────────────────────────────────────────────────────────
// Guards — stored JSON is untrusted input
// ─────────────────────────────────────────────────────────────────────────────

type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || isText(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTextList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isText);
}

function isCountsByRisk(value: unknown): value is Readonly<Record<RiskId, number>> {
  return isFields(value) && Object.values(value).every(isCount);
}

function isRequestKind(value: unknown): value is RequestKind {
  return value === 'claim' || value === 'approval';
}

function isRequestClosedState(value: unknown): value is RequestClosedState {
  return isText(value) && (REQUEST_CLOSED_STATES as readonly string[]).includes(value);
}

function isCallDetails(d: Fields): boolean {
  return (
    isText(d.tool) && isText(d.fingerprint) && isTextList(d.risk_ids) && isTextOrNull(d.agent_label)
  );
}

function isCallAllowed(d: Fields): d is Fields & CallAllowedEventDetails {
  return isCallDetails(d) && isCountsByRisk(d.remaining) && isTextList(d.approval_ids);
}

function isCallRefused(d: Fields): d is Fields & CallRefusedEventDetails {
  return (
    isCallDetails(d) &&
    isText(d.refusal_code) &&
    isRefusalCode(d.refusal_code) &&
    isTextOrNull(d.request_id)
  );
}

function isRequest(d: Fields): d is Fields & RequestEventDetails {
  if (!isText(d.request_id) || !isRequestKind(d.request_kind)) return false;
  // A closed request says how it closed; a dropped one names the call that asked.
  if (d.state !== undefined) return isRequestClosedState(d.state);
  return isText(d.tool) && isText(d.fingerprint);
}

function hasPeriod(d: Fields): boolean {
  return isText(d.period_start) && isTextOrNull(d.period_end);
}

function isReset(d: Fields): d is Fields & ResetEventDetails {
  return isText(d.request_id) && hasPeriod(d) && isCountsByRisk(d.credits);
}

function isExtension(d: Fields): d is Fields & ExtensionEventDetails {
  if (!isText(d.request_id)) return false;
  if (d.dimension === 'quota')
    return isCount(d.amount) && hasPeriod(d) && isCountsByRisk(d.credits);
  if (d.dimension === 'expiry') return isTextOrNull(d.expires_at_before) && isText(d.expires_at);
  return false;
}

function isApproval(d: Fields): d is Fields & ApprovalEventDetails {
  return (
    isText(d.request_id) &&
    isText(d.approval_id) &&
    isText(d.tool) &&
    isText(d.fingerprint) &&
    isText(d.expires_at)
  );
}

function isGateOpened(d: Fields): d is Fields & GateOpenedEventDetails {
  return isText(d.request_id) && isText(d.period_start) && isText(d.period_end);
}

function isGateChanged(d: Fields): d is Fields & GateChangedEventDetails {
  return isText(d.gate) && isGate(d.gate) && isText(d.gate_before) && isGate(d.gate_before);
}

function isRotation(d: Fields): d is Fields & RotationEventDetails {
  return isText(d.token_prefix);
}

function isRevocation(d: Fields): d is Fields & RevocationEventDetails {
  return isCount(d.tokens_revoked);
}

/**
 * The typed details of a stored event, or `null` when the kind has no details
 * shape or the stored object does not have the shape of its kind. Keys the
 * shape does not name are ignored. Never throws: a reader shows a `null` event
 * without detail and a check skips it.
 */
export function parseEventDetails(kind: string, details: unknown): SessionEventDetails | null {
  if (!isFields(details)) return null;
  switch (kind) {
    case 'call-allowed':
      return isCallAllowed(details) ? { kind, details } : null;
    case 'call-refused':
      return isCallRefused(details) ? { kind, details } : null;
    case 'request':
      return isRequest(details) ? { kind, details } : null;
    case 'extension':
      return isExtension(details) ? { kind, details } : null;
    case 'reset':
      return isReset(details) ? { kind, details } : null;
    case 'approval':
      return isApproval(details) ? { kind, details } : null;
    case 'gate-opened':
      return isGateOpened(details) ? { kind, details } : null;
    case 'gate-changed':
      return isGateChanged(details) ? { kind, details } : null;
    case 'rotation':
      return isRotation(details) ? { kind, details } : null;
    case 'revocation':
      return isRevocation(details) ? { kind, details } : null;
    default:
      return null;
  }
}
