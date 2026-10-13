/**
 * Request state machine — pure (spec §2.3).
 *
 *   open ──grant──▶ granted
 *        ──refuse─▶ refused
 *        ──expire─▶ expired      (unanswered after the configured delay)
 *
 * `granted`, `refused` and `expired` are terminal. The stored state of an
 * overdue request stays `open` until the sweeper (or the next decision
 * attempt) flips it; `effectiveState` is what every reader shows meanwhile.
 */
import type { Iso8601, RequestStatus } from '@vaubaan/shared';

export type RequestTransition = 'grant' | 'refuse' | 'expire';

const TARGET: Readonly<Record<RequestTransition, RequestStatus>> = {
  grant: 'granted',
  refuse: 'refused',
  expire: 'expired',
};

/** The state a transition leads to, or `null` when the state does not allow it. */
export function nextState(
  state: RequestStatus,
  transition: RequestTransition,
): RequestStatus | null {
  return state === 'open' ? TARGET[transition] : null;
}

export function isTerminal(state: RequestStatus): boolean {
  return state !== 'open';
}

interface Expiring {
  readonly state: RequestStatus;
  readonly expiresAt: Iso8601;
}

/** The state as of `now`: an open request past its expiry reads `expired`. */
export function effectiveState(request: Expiring, now: Date): RequestStatus {
  if (request.state === 'open' && Date.parse(request.expiresAt) <= now.getTime()) return 'expired';
  return request.state;
}

/** A decision is possible only on a request still open as of `now`. */
export function isDecidable(request: Expiring, now: Date): boolean {
  return effectiveState(request, now) === 'open';
}
