/**
 * Gates opened for the rest of the period — pure (spec §3.5).
 *
 * "On a request, the creator may choose to open the gate for the rest of the period:
 * the risk switches to `auto` until the next reload, then returns to `approval`. This
 * is a session event." The event is `gate-opened`, written by the request service with
 * the period it was granted in; `decide()` receives the set this module derives from
 * the session's events as `opened_gates`.
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
 */

import {
  parseEventDetails,
  type Iso8601,
  type RiskId,
  type SessionEventKind,
} from '@vaubaan/shared';
import type { CurrentPeriod } from './period.ts';

/** The event kinds that decide whether a gate is open: what `openedGatesOf` must be fed. */
export const GATE_EVENT_KINDS = [
  'gate-opened',
  'gate-changed',
] as const satisfies readonly SessionEventKind[];

/** What `openedGatesOf` reads of a stored session event. */
export interface GateEventLike {
  readonly ts: Iso8601;
  readonly kind: string;
  readonly riskId: RiskId | null;
  readonly details: Readonly<Record<string, unknown>> | null;
}

/**
 * The risks whose gate the creator opened for `period`, from the session's
 * `GATE_EVENT_KINDS` events of those risks since the period started (any order).
 */
export function openedGatesOf(
  events: readonly GateEventLike[],
  period: CurrentPeriod,
): Set<RiskId> {
  const openedAt = new Map<RiskId, number>();
  const changedAt = new Map<RiskId, number>();
  for (const event of events) {
    if (event.riskId === null) continue;
    const at = Date.parse(event.ts);
    const parsed = parseEventDetails(event.kind, event.details);
    if (!parsed || Number.isNaN(at)) continue;
    if (parsed.kind === 'gate-opened') {
      if (parsed.details.period_start !== period.start) continue;
      openedAt.set(event.riskId, Math.max(at, openedAt.get(event.riskId) ?? at));
    } else if (parsed.kind === 'gate-changed') {
      changedAt.set(event.riskId, Math.max(at, changedAt.get(event.riskId) ?? at));
    }
  }
  const opened = new Set<RiskId>();
  for (const [riskId, at] of openedAt) {
    const changed = changedAt.get(riskId);
    if (changed === undefined || changed < at) opened.add(riskId);
  }
  return opened;
}
