/**
 * One line per session event, for the creator's view of a request (spec §3.4
 * "the creator sees the session history"). Pure and total: an event kind this
 * module does not know (a later feature's) reads as its bare kind.
 *
 * Event details are written by the budget's `SessionService` (calls, request
 * drops), the `MissionService` (rotation, revocation) and the
 * `RequestService` (decisions, expiry); see the handbooks of each.
 */
import type { Iso8601, RiskId } from '@vaubaan/shared';

export interface SessionEventLike {
  readonly id: string;
  readonly ts: Iso8601;
  readonly kind: string;
  readonly riskId: RiskId | null;
  readonly actorUserId: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export interface SessionEventLine {
  readonly id: string;
  readonly at: Iso8601;
  readonly kind: string;
  readonly risk_id: RiskId | null;
  readonly summary: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function describeCall(verb: string, details: Readonly<Record<string, unknown>>): string {
  const tool = text(details.tool) ?? 'a tool';
  const label = text(details.agent_label);
  const code = text(details.refusal_code);
  return [`${verb} ${tool}`, code ? `(${code})` : null, label ? `by “${label}”` : null]
    .filter((part) => part !== null)
    .join(' ');
}

function describeRequest(details: Readonly<Record<string, unknown>>): string {
  const kind = text(details.request_kind) ?? 'request';
  const state = text(details.state);
  if (state === 'expired') return `The ${kind} expired unanswered`;
  if (state === 'refused') return `The creator refused the ${kind}`;
  return kind === 'approval'
    ? 'An approval request was dropped in the creator’s inbox'
    : 'A claim was dropped in the creator’s inbox';
}

function describeExtension(details: Readonly<Record<string, unknown>>): string {
  if (details.dimension === 'expiry') {
    const until = text(details.expires_at);
    return until
      ? `The creator extended the expiry to ${until}`
      : 'The creator extended the expiry';
  }
  const amount = typeof details.amount === 'number' ? details.amount : null;
  return amount === null
    ? 'The creator extended the quota for the period'
    : `The creator gave back ${amount} ${amount === 1 ? 'action' : 'actions'} for the period`;
}

export function describeEvent(event: SessionEventLike): string {
  const details = event.details ?? {};
  switch (event.kind) {
    case 'call-allowed':
      return describeCall('Allowed', details);
    case 'call-refused':
      return describeCall('Refused', details);
    case 'request':
      return describeRequest(details);
    case 'reset':
      return 'The creator reset the period: every counter back to zero';
    case 'extension':
      return describeExtension(details);
    case 'rotation':
      return 'The mission token was rotated';
    case 'revocation':
      return 'The mission was revoked';
    default:
      return event.kind;
  }
}

export function eventLineOf(event: SessionEventLike): SessionEventLine {
  return {
    id: event.id,
    at: event.ts,
    kind: event.kind,
    risk_id: event.riskId,
    summary: describeEvent(event),
  };
}
