/**
 * Gates opened for the rest of the period — pure (spec §3.5).
 *
 * "On a request, the creator may choose to open the gate for the rest of the period:
 * the risk switches to `auto` until the next reload, then returns to `approval`. This
 * is a mission log event." The event is `gate-opened`, written by the request service with
 * the period it was granted in; `decide()` receives the set this module derives from
 * the mission log's events as `opened_gates`.
 *
 * Two rules bound an opening:
 *
 *   - the period: an opening counts only for the period whose start it carries. After
 *     the rollover the current period has another start, no stored opening matches it,
 *     and the gate reads `approval` again — nothing runs to close it;
 *   - a later edit: when the creator sets the risk's gate on the mission itself
 *     (`gate-changed`), the opening granted before it ends. An edit recorded at the very
 *     instant of an opening wins too: on a tie the gate stays closed.
 *
 * Details are read through `parseEventDetails` only: an event whose stored details do
 * not have the shape of its kind opens nothing.
 *
 * An opening is about one line: a risk in one resource set (risk model §4.7, the
 * event's `resource_set_id` column). An opening that names no set opens nothing; a
 * change that names no set closes the risk in every set — the strict reading.
 */

import {
  parseEventDetails,
  policyLineKey,
  type Iso8601,
  type PolicyLineKey,
  type RiskId,
  type MissionLogEventKind,
} from '@vaubaan/shared';
import type { CurrentPeriod } from './period.ts';

/** The event kinds that decide whether a gate is open: what `openedGatesOf` must be fed. */
export const GATE_EVENT_KINDS = [
  'gate-opened',
  'gate-changed',
  // A permission removed by an edit ends its opening: added again, it asks again.
  'permission-removed',
] as const satisfies readonly MissionLogEventKind[];

/**
 * The gate that applies to a risk now: `approval` unless the policy says `auto` or the
 * creator opened it for the period (`openedGatesOf`). The one spelling of that rule:
 * the budget decides a call with it and the request page shows each touched risk with it.
 */
export function effectiveGate(
  entry: { readonly risk_id: RiskId; readonly gate: 'auto' | 'approval' },
  openedGates: ReadonlySet<RiskId>,
): 'auto' | 'approval' {
  return entry.gate === 'approval' && !openedGates.has(entry.risk_id) ? 'approval' : 'auto';
}

/** What `openedGatesOf` reads of a stored mission log event. */
export interface GateEventLike {
  readonly ts: Iso8601;
  readonly kind: string;
  readonly riskId: RiskId | null;
  readonly resourceSetId: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;
}

/**
 * The lines (set, risk) whose gate the creator opened for `period`, from the mission log's
 * `GATE_EVENT_KINDS` events of those risks since the period started (any order).
 */
export function openedGatesOf(
  events: readonly GateEventLike[],
  period: CurrentPeriod,
): Set<PolicyLineKey> {
  const openedAt = new Map<PolicyLineKey, { readonly riskId: RiskId; at: number }>();
  const changedAt = new Map<PolicyLineKey, number>();
  const changedEverywhereAt = new Map<RiskId, number>();
  for (const event of events) {
    if (event.riskId === null) continue;
    const at = Date.parse(event.ts);
    const parsed = parseEventDetails(event.kind, event.details);
    if (!parsed || Number.isNaN(at)) continue;
    if (parsed.kind === 'gate-opened') {
      if (parsed.details.period_start !== period.start || event.resourceSetId === null) continue;
      const key = policyLineKey(event.resourceSetId, event.riskId);
      const seen = openedAt.get(key);
      openedAt.set(key, { riskId: event.riskId, at: Math.max(at, seen?.at ?? at) });
    } else if (parsed.kind === 'gate-changed' || parsed.kind === 'permission-removed') {
      if (event.resourceSetId === null) {
        changedEverywhereAt.set(
          event.riskId,
          Math.max(at, changedEverywhereAt.get(event.riskId) ?? at),
        );
        continue;
      }
      const key = policyLineKey(event.resourceSetId, event.riskId);
      changedAt.set(key, Math.max(at, changedAt.get(key) ?? at));
    }
  }
  const opened = new Set<PolicyLineKey>();
  for (const [key, { riskId, at }] of openedAt) {
    const changed = Math.max(
      changedAt.get(key) ?? -Infinity,
      changedEverywhereAt.get(riskId) ?? -Infinity,
    );
    if (changed < at) opened.add(key);
  }
  return opened;
}

/** The risks of one set among opened lines: what `decide()` of that set is given. */
export function openedInSet(
  opened: ReadonlySet<PolicyLineKey>,
  resourceSetId: string,
): Set<RiskId> {
  const prefix = policyLineKey(resourceSetId, '');
  const risks = new Set<RiskId>();
  for (const key of opened) if (key.startsWith(prefix)) risks.add(key.slice(prefix.length));
  return risks;
}
