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
  type ApprovalEventDetails,
  type CallAllowedEventDetails,
  type CallRefusedEventDetails,
  type ExtensionEventDetails,
  type GateChangedEventDetails,
  type GateOpenedEventDetails,
  type Iso8601,
  type RequestEventDetails,
  type RevocationEventDetails,
  type RiskId,
  type RotationEventDetails,
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
const ROTATION_LINE = 'A mission token was rotated';
const TOKEN_ISSUED_LINE = 'A mission token was issued';
const REVOCATION_LINE = 'The mission was revoked';
const TOKEN_REVOKED_LINE = 'One token of the mission was revoked';

/**
 * A `rotation` event is a token issued to one holder: a rotation when it replaced
 * their previous one, a first token otherwise. An event stored before tokens had a
 * holder (no `token_kind`) was always a rotation.
 */
function describeRotation(details: RotationEventDetails): string {
  const first = details.token_kind && !details.replaced_prefix;
  return first ? TOKEN_ISSUED_LINE : ROTATION_LINE;
}

/** One token revoked on its own names it; without a prefix the whole mission was revoked. */
function describeRevocation(details: RevocationEventDetails): string {
  return details.token_prefix ? TOKEN_REVOKED_LINE : REVOCATION_LINE;
}

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

/** `claim`, `approval request`: the kind as a sentence names it. */
function nameOf(kind: RequestEventDetails['request_kind']): string {
  return kind === 'approval' ? 'approval request' : kind;
}

function describeRequest(details: RequestEventDetails): string {
  const kind = nameOf(details.request_kind);
  if ('state' in details) {
    return details.state === 'expired'
      ? `The ${kind} expired unanswered`
      : `The creator refused the ${kind}`;
  }
  return details.request_kind === 'approval'
    ? `An approval request for ${details.tool || 'a tool'} was dropped in the creator’s inbox`
    : 'A claim was dropped in the creator’s inbox';
}

function describeApproval(details: ApprovalEventDetails): string {
  return `The creator approved one ${details.tool || 'call'}, usable until ${details.expires_at}`;
}

function describeGateOpened(details: GateOpenedEventDetails): string {
  return `The creator opened the gate until the period ends (${details.period_end})`;
}

function describeGateChanged(details: GateChangedEventDetails): string {
  return `The creator set the gate to ${details.gate} (was ${details.gate_before})`;
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
    case 'approval':
      return 'The creator approved an action';
    case 'gate-opened':
      return 'The creator opened a gate for the period';
    case 'gate-changed':
      return 'The creator edited a gate';
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
    case 'approval':
      return describeApproval(parsed.details);
    case 'gate-opened':
      return describeGateOpened(parsed.details);
    case 'gate-changed':
      return describeGateChanged(parsed.details);
    case 'rotation':
      return describeRotation(parsed.details);
    case 'revocation':
      return describeRevocation(parsed.details);
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
