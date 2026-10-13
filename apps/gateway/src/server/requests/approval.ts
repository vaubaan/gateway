/**
 * What the creator may do with an approval request — pure (spec §3.5).
 *
 * Three resolutions:
 *
 *   grant       one approval for the call the creator read — this tool, these exact
 *               arguments — single-use, valid for the delay the operator configured
 *   open-gate   the risk's gate reads `auto` until the current period ends, for every
 *               call (this one included), then `approval` again
 *   refuse      nothing runs; a replay is refused again and asks again
 *
 * None of them edits the policy, and none of them bypasses the budget: an approved
 * action counts against the quota and the rate limit of every risk it touches.
 *
 * Browser-safe: values only, no store, no `node:` import.
 */
import type { Gate, Iso8601, RiskId } from '@vaubaan/shared';

import { formatUtc, type ClaimMissionState } from './claim';

export const APPROVAL_RESOLUTIONS = ['grant', 'open-gate', 'refuse'] as const;
export type ApprovalResolution = (typeof APPROVAL_RESOLUTIONS)[number];

export interface ApprovalDecision {
  readonly resolution: ApprovalResolution;
}

/** Everything the choice depends on, read at decision time. */
export interface ApprovalSituation {
  readonly mission_state: ClaimMissionState;
  /** End of the current period; `null` for a one-off mission. */
  readonly period_end: Iso8601 | null;
  readonly risk_id: RiskId;
  readonly tool: string;
  /** The risk's gate in the mission's policy now; `null` when the risk left the policy. */
  readonly gate: Gate | null;
  /** The gate is already open for the current period. */
  readonly gate_open: boolean;
  /** How long a granted approval stays usable (`approvals.expiry`). */
  readonly approval_valid_seconds: number;
}

export const APPROVAL_PROBLEM_CODES = [
  'invalid-decision',
  'mission-closed',
  'mission-expired',
  'risk-not-in-policy',
  'gate-not-closed',
  'no-period-end',
] as const;
export type ApprovalProblemCode = (typeof APPROVAL_PROBLEM_CODES)[number];

export interface ApprovalProblem {
  readonly code: ApprovalProblemCode;
  readonly message: string;
}

export interface ApprovalOption {
  readonly resolution: ApprovalResolution;
  readonly label: string;
  /** One line: what choosing it does. */
  readonly consequence: string;
  /** Why it cannot be chosen now; `null` when it can. */
  readonly unavailable: ApprovalProblem | null;
}

const LABELS: Readonly<Record<ApprovalResolution, string>> = {
  grant: 'Approve this action',
  'open-gate': 'Open the gate for the rest of the period',
  refuse: 'Refuse',
};

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** `10 minutes`, `90 seconds`, `2 hours` — the largest unit that divides the delay. */
export function formatDelay(seconds: number): string {
  if (seconds >= SECONDS_PER_HOUR && seconds % SECONDS_PER_HOUR === 0) {
    return plural(seconds / SECONDS_PER_HOUR, 'hour');
  }
  if (seconds >= SECONDS_PER_MINUTE && seconds % SECONDS_PER_MINUTE === 0) {
    return plural(seconds / SECONDS_PER_MINUTE, 'minute');
  }
  return plural(seconds, 'second');
}

/** Why nothing but a refusal can be recorded; `null` when the mission still runs the risk. */
function missionProblem(situation: ApprovalSituation): ApprovalProblem | null {
  const state = situation.mission_state;
  if (state === 'revoked' || state === 'orphaned') {
    return {
      code: 'mission-closed',
      message: `The mission is ${state}: every call is refused whatever you approve.`,
    };
  }
  if (state === 'expired') {
    return {
      code: 'mission-expired',
      message: 'The mission is expired: every call is refused until its expiry is extended.',
    };
  }
  if (situation.gate === null) {
    return {
      code: 'risk-not-in-policy',
      message: `'${situation.risk_id}' is no longer accepted by the mission.`,
    };
  }
  return null;
}

function openGateProblem(situation: ApprovalSituation): ApprovalProblem | null {
  const problem = missionProblem(situation);
  if (problem) return problem;
  if (situation.gate !== 'approval') {
    return {
      code: 'gate-not-closed',
      message: `The gate of '${situation.risk_id}' is already auto on the mission: calls pass without asking.`,
    };
  }
  if (situation.gate_open) {
    return {
      code: 'gate-not-closed',
      message: `The gate of '${situation.risk_id}' is already open for this period.`,
    };
  }
  if (situation.period_end === null) {
    return {
      code: 'no-period-end',
      message:
        'This mission has a single period that never ends, so there is no "rest of the period". Set the gate to auto on the mission page instead.',
    };
  }
  return null;
}

/** The three actions, always in the same order, each with its one-line consequence. */
export function approvalOptions(situation: ApprovalSituation): ApprovalOption[] {
  const { risk_id: risk, tool, period_end: periodEnd } = situation;
  const validity = formatDelay(situation.approval_valid_seconds);
  const until = periodEnd ? `until the period ends (${formatUtc(periodEnd)})` : 'for the period';
  return [
    {
      resolution: 'grant',
      label: LABELS.grant,
      consequence: `The executor may replay this exact call — ${tool} with the arguments shown — once, within ${validity}. It counts against the quota and the rate limit of every risk it touches; any other call on '${risk}' asks again.`,
      unavailable: missionProblem(situation),
    },
    {
      resolution: 'open-gate',
      label: LABELS['open-gate'],
      consequence: `Every call touching '${risk}' passes without asking you ${until}, this one included and whatever its arguments, within the budget. The gate is approval again from the next period.`,
      unavailable: openGateProblem(situation),
    },
    {
      resolution: 'refuse',
      label: LABELS.refuse,
      consequence:
        'Nothing runs. If the executor replays the call it is refused again and a new request is dropped here.',
      unavailable: null,
    },
  ];
}

/** Checks a decision against the situation; `null` when it may be applied. */
export function checkApprovalDecision(
  situation: ApprovalSituation,
  decision: ApprovalDecision,
): ApprovalProblem | null {
  switch (decision.resolution) {
    case 'refuse':
      return null;
    case 'grant':
      return missionProblem(situation);
    case 'open-gate':
      return openGateProblem(situation);
  }
}

export type ParsedApprovalDecision =
  | { readonly ok: true; readonly decision: ApprovalDecision }
  | { readonly ok: false; readonly problem: ApprovalProblem };

function isResolution(value: unknown): value is ApprovalResolution {
  return typeof value === 'string' && (APPROVAL_RESOLUTIONS as readonly string[]).includes(value);
}

/**
 * A decision as it arrives over HTTP: a JSON body, or the fields of the page's forms.
 * Unknown keys are refused: an approval takes a resolution and nothing else.
 */
export function parseApprovalDecision(raw: unknown): ParsedApprovalDecision {
  const invalid = (message: string): ParsedApprovalDecision => ({
    ok: false,
    problem: { code: 'invalid-decision', message },
  });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid('The decision is an object with a "resolution".');
  }
  const input = raw as Record<string, unknown>;
  const resolution = input.resolution;
  if (!isResolution(resolution)) {
    return invalid(`"resolution" is one of: ${APPROVAL_RESOLUTIONS.join(', ')}.`);
  }
  const extra = Object.keys(input).filter((key) => key !== 'resolution');
  if (extra.length > 0) {
    return invalid(`Unexpected field(s) for ${resolution}: ${extra.join(', ')}.`);
  }
  return { ok: true, decision: { resolution } };
}
