/**
 * Who asked — pure (spec §3.4 "the creator sees the mission log history", §8 "the
 * token the call presented and its holder").
 *
 * A request row names its mission, never the caller: the call that was refused
 * is a `call-refused` event of the mission log, and that event carries
 * the `request_id` the refusal pointed to, the token's holder (authenticated)
 * and the label the agent gave itself (a claim). This module reads the answer
 * to "who asks, and with what" out of those events; the service turns the
 * holder key into a name.
 *
 * A replay of the same call while the request is open is refused again and
 * points to the same request: the first event is who asked, the count is how
 * many calls were stopped since.
 */
import { parseEventDetails, type MissionTokenKind } from '@vaubaan/shared';

import type { MissionLogEventLike } from './events';

/** The event kind a refused call is recorded under. */
export const REFUSED_CALL_KIND = 'call-refused';

export interface AskedBy {
  /** `null` on an event stored before tokens had a holder. */
  readonly token_kind: MissionTokenKind | null;
  /** The member's user id (`member`) or the token's name (`named`), as the event keeps it. */
  readonly holder: string | null;
  /** What the agent said about itself; never verified. */
  readonly agent_label: string | null;
  /** The tool of the refused call. */
  readonly tool: string | null;
  /** The calls refused with this request in their refusal, the first one included. */
  readonly refused_calls: number;
}

/**
 * The caller behind a request, from the refused calls of its mission log (any
 * order). `null` when no event points to the request: its mission log is gone, or
 * the events were purged by retention.
 */
export function askedBy(events: readonly MissionLogEventLike[], requestId: string): AskedBy | null {
  let first: { readonly ts: string; readonly asked: Omit<AskedBy, 'refused_calls'> } | null = null;
  let refused = 0;
  for (const event of events) {
    if (event.kind !== REFUSED_CALL_KIND) continue;
    const parsed = parseEventDetails(event.kind, event.details);
    if (!parsed || parsed.kind !== REFUSED_CALL_KIND) continue;
    if (parsed.details.request_id !== requestId) continue;
    refused += 1;
    if (first === null || event.ts < first.ts) {
      first = {
        ts: event.ts,
        asked: {
          token_kind: parsed.details.token_kind ?? null,
          holder: parsed.details.holder ?? null,
          agent_label: parsed.details.agent_label,
          tool: parsed.details.tool || null,
        },
      };
    }
  }
  return first ? { ...first.asked, refused_calls: refused } : null;
}
