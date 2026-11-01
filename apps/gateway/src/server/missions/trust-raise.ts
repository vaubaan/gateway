/**
 * Trust-raise proposals (risk model §4.7): after enough approvals granted on one
 * macro-action of one resource set, with no refusal since its trust level last
 * changed, the creator is offered to raise that trust level by one.
 *
 * Pure: the mission, its requests, its marks and the catalog's macro-actions in, the
 * offers out. Nothing here raises anything: "Raise" opens the ordinary edit at the next
 * level, and "Not now" stamps the mark the count then starts from
 * (`MissionsRepo.snoozeTrustRaise`).
 *
 * The count of one macro-action of one set starts at the latest of: the mission's
 * issuance, the last edit that changed its trust level, the last "Not now", the last
 * approval request on it the creator refused. It counts the approval requests granted
 * since then (an approval for the call or the gate opened for the period) that are about
 * a line of that set whose risk belongs to the macro-action. Claims are budget widenings:
 * a separate offer, never counted here. A macro-action at Autonomous, or with no trust
 * level stored (the set was composed by hand), is never offered.
 */
import { isTrustLevel, TRUST_LEVELS, type TrustLevel } from '@vaubaan/policy-engine';
import { baseRiskId, type MacroAction, type RiskId } from '@vaubaan/shared';

import type { MissionRecord, MissionTrustMarkRecord, RequestRecord } from '../store/types';

/** One offer to raise one macro-action of one set by one trust level. */
export interface TrustRaiseOffer {
  readonly connection_id: string;
  /** The account's display name. */
  readonly account_name: string;
  readonly resource_set_id: string;
  /** The set's place among the sets of its account, from 1. */
  readonly resource_set_position: number;
  /** The account holds several sets: the offer names the set. */
  readonly several_sets: boolean;
  readonly macro_action_id: string;
  readonly macro_action_label: string;
  readonly from: TrustLevel;
  readonly to: TrustLevel;
  /** Approvals granted on it since the count started. */
  readonly approvals: number;
}

export interface TrustRaiseInput {
  readonly mission: Pick<MissionRecord, 'createdAt' | 'connections'>;
  /**
   * The connection's name and macro-actions ("Anything else" included), or `null` when
   * the connection or its plugin is gone.
   */
  readonly accountOf: (connectionId: string) => {
    readonly name: string;
    readonly macroActions: readonly MacroAction[];
  } | null;
  readonly requests: readonly Pick<RequestRecord, 'kind' | 'state' | 'lines' | 'decidedAt'>[];
  readonly marks: readonly MissionTrustMarkRecord[];
  /** `trust_raise.after_approvals`. */
  readonly threshold: number;
}

/** The trust level one above, or `null` at the top. */
export function nextTrustLevel(level: TrustLevel): TrustLevel | null {
  return TRUST_LEVELS[TRUST_LEVELS.indexOf(level) + 1] ?? null;
}

function latest(...instants: readonly (string | null | undefined)[]): string {
  return instants.reduce<string>((max, at) => (at && at > max ? at : max), '');
}

function baseOf(riskId: RiskId): RiskId | null {
  try {
    return baseRiskId(riskId);
  } catch {
    return null;
  }
}

export function trustRaiseOffers(input: TrustRaiseInput): TrustRaiseOffer[] {
  const { mission, requests, threshold } = input;
  const marks = new Map(input.marks.map((m) => [`${m.resourceSetId}::${m.macroActionId}`, m]));
  const approvals = requests.filter((r) => r.kind === 'approval' && r.decidedAt !== null);
  const offers: TrustRaiseOffer[] = [];
  for (const connection of mission.connections) {
    const account = input.accountOf(connection.connectionId);
    if (!account) continue;
    const actions = account.macroActions;
    const several = connection.resourceSets.length > 1;
    for (const set of connection.resourceSets) {
      for (const [actionId, level] of Object.entries(set.trustLevels ?? {})) {
        if (!isTrustLevel(level)) continue;
        const to = nextTrustLevel(level);
        const action = actions.find((a) => a.id === actionId);
        if (!to || !action) continue;
        const bases = new Set(action.entries.map((e) => e.risk_id));
        const onIt = approvals.filter((r) =>
          r.lines.some((line) => {
            if (line.resourceSetId !== set.id) return false;
            const base = baseOf(line.riskId);
            return base !== null && bases.has(base);
          }),
        );
        const mark = marks.get(`${set.id}::${actionId}`);
        const lastRefusal = latest(
          ...onIt.filter((r) => r.state === 'refused').map((r) => r.decidedAt),
        );
        const since = latest(mission.createdAt, mark?.levelChangedAt, mark?.snoozedAt, lastRefusal);
        const granted = onIt.filter(
          (r) => r.state === 'granted' && r.decidedAt !== null && r.decidedAt > since,
        ).length;
        if (granted < threshold) continue;
        offers.push({
          connection_id: connection.connectionId,
          account_name: account.name,
          resource_set_id: set.id,
          resource_set_position: set.position,
          several_sets: several,
          macro_action_id: actionId,
          macro_action_label: action.label,
          from: level,
          to,
          approvals: granted,
        });
      }
    }
  }
  return offers;
}
