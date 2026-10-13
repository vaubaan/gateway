/**
 * One line per session event, for the creator's view of a request (spec §3.4
 * "the creator sees the session history"). Pure and total: an event kind this
 * module does not know (a later feature's) reads as its bare kind.
 *
 * Event details are written by the budget's `SessionService` (calls, request
 * drops), the `MissionService` (rotation, revocation) and the
 * `RequestService` (decisions, expiry); see the handbooks of each. They are
 * read through `parseEventDetails` (`@vaubaan/shared`) only: an event whose
 * stored details do not have the shape of its kind reads as a line without
 * detail, never as a throw.
 */
import {
  parseEventDetails,
  type CallAllowedEventDetails,
  type CallRefusedEventDetails,
  type ExtensionEventDetails,
  type Iso8601,
  type RequestEventDetails,
  type RiskId,
} from '@vaubaan/shared';

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

const RESET_LINE = 'The creator reset the period: every counter back to zero';
const ROTATION_LINE = 'The mission token was rotated';
const REVOCATION_LINE = 'The mission was revoked';

function describeCall(
  verb: string,
  details: CallAllowedEventDetails | CallRefusedEventDetails,
): string {
  const tool = details.tool || 'a tool';
  const code = 'refusal_code' in details ? details.refusal_code : null;
  const label = details.agent_label;
  return [`${verb} ${tool}`, code ? `(${code})` : null, label ? `by “${label}”` : null]
    .filter((part) => part !== null)
    .join(' ');
}

function describeRequest(details: RequestEventDetails): string {
  const kind = details.request_kind;
  if ('state' in details) {
    return details.state === 'expired'
      ? `The ${kind} expired unanswered`
      : `The creator refused the ${kind}`;
  }
  return kind === 'approval'
    ? 'An approval request was dropped in the creator’s inbox'
    : 'A claim was dropped in the creator’s inbox';
}

function describeExtension(details: ExtensionEventDetails): string {
  if (details.dimension === 'expiry') {
    return `The creator extended the expiry to ${details.expires_at}`;
  }
  const { amount } = details;
  return `The creator gave back ${amount} ${amount === 1 ? 'action' : 'actions'} for the period`;
}

/** The line of an event whose stored details cannot be read: the kind, no detail. */
function describeWithoutDetails(kind: string): string {
  switch (kind) {
    case 'call-allowed':
      return 'Allowed a tool';
    case 'call-refused':
      return 'Refused a tool';
    case 'request':
      return 'A request changed state';
    case 'reset':
      return RESET_LINE;
    case 'extension':
      return 'The creator extended the mission';
    case 'rotation':
      return ROTATION_LINE;
    case 'revocation':
      return REVOCATION_LINE;
    default:
      return kind;
  }
}

export function describeEvent(event: SessionEventLike): string {
  const parsed = parseEventDetails(event.kind, event.details);
  if (!parsed) return describeWithoutDetails(event.kind);
  switch (parsed.kind) {
    case 'call-allowed':
      return describeCall('Allowed', parsed.details);
    case 'call-refused':
      return describeCall('Refused', parsed.details);
    case 'request':
      return describeRequest(parsed.details);
    case 'reset':
      return RESET_LINE;
    case 'extension':
      return describeExtension(parsed.details);
    case 'rotation':
      return ROTATION_LINE;
    case 'revocation':
      return REVOCATION_LINE;
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
