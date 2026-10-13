/**
 * What the creator may do with a claim — pure (spec §3.4).
 *
 * Four resolutions (`ClaimResolution` of `@vaubaan/shared`):
 *
 *   reset-period    every counter of the mission's current period goes back to zero
 *   extend-quota    N actions given back on the claimed risk, current period only
 *   extend-expiry   the mission runs until a later date
 *   refuse          nothing changes; the risk stays exhausted until the next period
 *
 * A claim never edits the policy: the quota of the next period is the
 * mission's, and a permanent change goes through the mission itself.
 * `extend-quota` gives back actions already consumed in the period, so its
 * amount is bounded by what was consumed (the counters never go below zero).
 *
 * Browser-safe: values only, no store, no `node:` import.
 */
import type { ClaimResolution, Iso8601, RiskId } from '@vaubaan/shared';

export const CLAIM_RESOLUTIONS = [
  'reset-period',
  'extend-quota',
  'extend-expiry',
  'refuse',
] as const satisfies readonly ClaimResolution[];

export type ClaimDecision =
  | { readonly resolution: 'reset-period' }
  | { readonly resolution: 'extend-quota'; readonly amount: number }
  | { readonly resolution: 'extend-expiry'; readonly expires_at: Iso8601 }
  | { readonly resolution: 'refuse' };

/** Mission state as a claim sees it (`MissionState['kind']` of the budget). */
export type ClaimMissionState = 'active' | 'expired' | 'orphaned' | 'revoked';

/** Everything the choice depends on, read at decision time. */
export interface ClaimSituation {
  readonly now: Date;
  readonly mission_state: ClaimMissionState;
  readonly expires_at: Iso8601 | null;
  /** End of the current period; `null` for a one-off mission. */
  readonly period_end: Iso8601 | null;
  readonly risk_id: RiskId;
  /** `null` when the risk left the mission's policy since the claim was dropped. */
  readonly quota: number | null;
  /** Actions consumed on the claimed risk in the current period. */
  readonly consumed: number;
}

export const CLAIM_PROBLEM_CODES = [
  'invalid-decision',
  'invalid-amount',
  'invalid-expiry',
  'mission-closed',
  'mission-expired',
  'risk-not-in-policy',
  'nothing-consumed',
  'no-expiry',
] as const;
export type ClaimProblemCode = (typeof CLAIM_PROBLEM_CODES)[number];

export interface ClaimProblem {
  readonly code: ClaimProblemCode;
  readonly message: string;
}

export interface ClaimOption {
  readonly resolution: ClaimResolution;
  readonly label: string;
  /** One line: what choosing it does. */
  readonly consequence: string;
  /** Why it cannot be chosen now; `null` when it can. */
  readonly unavailable: ClaimProblem | null;
  /** `extend-quota`: the largest amount accepted. */
  readonly max_amount?: number;
  /** `extend-expiry`: the new date must be strictly after this instant. */
  readonly after?: Iso8601;
}

const LABELS: Readonly<Record<ClaimResolution, string>> = {
  'reset-period': 'Reset the period',
  'extend-quota': 'Extend the quota',
  'extend-expiry': 'Extend the expiry',
  refuse: 'Refuse',
};

/** `2026-10-14 09:00 UTC` — deterministic, the same on the server and in a test. */
export function formatUtc(iso: Iso8601): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function untilPeriodEnd(periodEnd: Iso8601 | null): string {
  return periodEnd
    ? `until the period ends (${formatUtc(periodEnd)})`
    : 'for the rest of this one-off mission';
}

function closedProblem(state: ClaimMissionState): ClaimProblem | null {
  if (state === 'revoked' || state === 'orphaned') {
    return {
      code: 'mission-closed',
      message: `The mission is ${state}: every call is refused whatever its budget.`,
    };
  }
  return null;
}

/** Why a budget resolution (reset, quota) cannot apply; `null` when it can. */
function budgetProblem(situation: ClaimSituation): ClaimProblem | null {
  const closed = closedProblem(situation.mission_state);
  if (closed) return closed;
  if (situation.mission_state === 'expired') {
    return {
      code: 'mission-expired',
      message: 'The mission is expired: extend its expiry first, the executor will claim again.',
    };
  }
  if (situation.quota === null) {
    return {
      code: 'risk-not-in-policy',
      message: `'${situation.risk_id}' is no longer accepted by the mission.`,
    };
  }
  return null;
}

function quotaProblem(situation: ClaimSituation): ClaimProblem | null {
  const problem = budgetProblem(situation);
  if (problem) return problem;
  if (situation.consumed < 1) {
    return {
      code: 'nothing-consumed',
      message: `Nothing was consumed on '${situation.risk_id}' in the current period; there is nothing to give back.`,
    };
  }
  return null;
}

function expiryProblem(situation: ClaimSituation): ClaimProblem | null {
  const closed = closedProblem(situation.mission_state);
  if (closed) return closed;
  if (situation.expires_at === null) {
    return { code: 'no-expiry', message: 'The mission never expires; there is nothing to extend.' };
  }
  return null;
}

/** The instant a new expiry must come after: the later of now and the current expiry. */
function expiryFloor(situation: ClaimSituation): Iso8601 {
  const now = situation.now.getTime();
  const current = situation.expires_at ? Date.parse(situation.expires_at) : now;
  return new Date(Math.max(now, current)).toISOString();
}

/** The four actions, always in the same order, each with its one-line consequence. */
export function claimOptions(situation: ClaimSituation): ClaimOption[] {
  const { risk_id: risk, period_end: periodEnd, quota, consumed } = situation;
  const exhaustedUntil = untilPeriodEnd(periodEnd);
  const afterwards = periodEnd
    ? `the quota is ${quota ?? 'the mission’s'} again from the next period`
    : 'a permanent change goes through the mission itself';
  return [
    {
      resolution: 'reset-period',
      label: LABELS['reset-period'],
      consequence: `Every counter of this mission goes back to zero ${exhaustedUntil}; the policy does not change.`,
      unavailable: budgetProblem(situation),
    },
    {
      resolution: 'extend-quota',
      label: LABELS['extend-quota'],
      consequence: `Gives back the number of actions you choose on '${risk}' (at most ${consumed}, what was consumed) for the current period only; ${afterwards}.`,
      unavailable: quotaProblem(situation),
      max_amount: consumed,
    },
    {
      resolution: 'extend-expiry',
      label: LABELS['extend-expiry'],
      consequence: `The mission runs until the date you choose; '${risk}' stays exhausted ${exhaustedUntil}.`,
      unavailable: expiryProblem(situation),
      after: expiryFloor(situation),
    },
    {
      resolution: 'refuse',
      label: LABELS.refuse,
      consequence: `Nothing changes: '${risk}' stays exhausted ${exhaustedUntil}, the mission stays usable for its other risks.`,
      unavailable: null,
    },
  ];
}

/** Checks a decision against the situation; `null` when it may be applied. */
export function checkClaimDecision(
  situation: ClaimSituation,
  decision: ClaimDecision,
): ClaimProblem | null {
  switch (decision.resolution) {
    case 'refuse':
      return null;
    case 'reset-period':
      return budgetProblem(situation);
    case 'extend-quota': {
      const problem = quotaProblem(situation);
      if (problem) return problem;
      if (!Number.isInteger(decision.amount) || decision.amount < 1) {
        return {
          code: 'invalid-amount',
          message: 'The amount is a whole number of actions, at least 1.',
        };
      }
      if (decision.amount > situation.consumed) {
        return {
          code: 'invalid-amount',
          message: `At most ${situation.consumed} actions can be given back: that is what was consumed on '${situation.risk_id}' in the current period. A larger quota goes through the mission itself.`,
        };
      }
      return null;
    }
    case 'extend-expiry': {
      const problem = expiryProblem(situation);
      if (problem) return problem;
      const target = Date.parse(decision.expires_at);
      if (Number.isNaN(target)) {
        return { code: 'invalid-expiry', message: 'The new expiry is not a date.' };
      }
      const floor = expiryFloor(situation);
      if (target <= Date.parse(floor)) {
        return {
          code: 'invalid-expiry',
          message: `The new expiry must be later than ${formatUtc(floor)}.`,
        };
      }
      return null;
    }
  }
}

export type ParsedClaimDecision =
  | { readonly ok: true; readonly decision: ClaimDecision }
  | { readonly ok: false; readonly problem: ClaimProblem };

function invalid(code: ClaimProblemCode, message: string): ParsedClaimDecision {
  return { ok: false, problem: { code, message } };
}

const FIELDS: Readonly<Record<ClaimResolution, readonly string[]>> = {
  'reset-period': [],
  'extend-quota': ['amount'],
  'extend-expiry': ['expires_at'],
  refuse: [],
};

function isResolution(value: unknown): value is ClaimResolution {
  return typeof value === 'string' && (CLAIM_RESOLUTIONS as readonly string[]).includes(value);
}

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * A date-time with no offset (what a `datetime-local` field posts) is read as
 * UTC, whatever the time zone of the process: the page labels the field so.
 */
function asUtc(value: string): string {
  return LOCAL_DATE_TIME.test(value) ? `${value}Z` : value;
}

/**
 * A decision as it arrives over HTTP: a JSON body, or the fields of the
 * page's forms (where every value is a string). Unknown keys are refused.
 */
export function parseClaimDecision(raw: unknown): ParsedClaimDecision {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid('invalid-decision', 'The decision is an object with a "resolution".');
  }
  const input = raw as Record<string, unknown>;
  const resolution = input.resolution;
  if (!isResolution(resolution)) {
    return invalid('invalid-decision', `"resolution" is one of: ${CLAIM_RESOLUTIONS.join(', ')}.`);
  }
  const extra = Object.keys(input).filter(
    (key) => key !== 'resolution' && !FIELDS[resolution].includes(key),
  );
  if (extra.length > 0) {
    return invalid(
      'invalid-decision',
      `Unexpected field(s) for ${resolution}: ${extra.join(', ')}.`,
    );
  }

  switch (resolution) {
    case 'reset-period':
      return { ok: true, decision: { resolution } };
    case 'refuse':
      return { ok: true, decision: { resolution } };
    case 'extend-quota': {
      const amount = typeof input.amount === 'string' ? Number(input.amount.trim()) : input.amount;
      if (typeof amount !== 'number' || !Number.isInteger(amount)) {
        return invalid('invalid-amount', '"amount" is a whole number of actions.');
      }
      return { ok: true, decision: { resolution, amount } };
    }
    case 'extend-expiry': {
      const value = input.expires_at;
      const ms = typeof value === 'string' ? Date.parse(asUtc(value.trim())) : Number.NaN;
      if (Number.isNaN(ms)) {
        return invalid('invalid-expiry', '"expires_at" is an ISO-8601 date.');
      }
      return { ok: true, decision: { resolution, expires_at: new Date(ms).toISOString() } };
    }
  }
}
