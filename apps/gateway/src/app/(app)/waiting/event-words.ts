/**
 * One event of a mission's session, in the words of the interface — pure.
 *
 * The page of a request is read by the creator of its mission and nobody else
 * (handbook requests, "Access rule"), and only the creator answers a request
 * or edits what a permission does: the acts of a person are therefore said as
 * "you". A call is said with its tool and its refusal code as the protocol
 * spells them — the page prints them in mono.
 *
 * `parseEventDetails` is the only reader of stored details: an event whose
 * details do not have the shape of its kind is worded without detail, never
 * thrown on.
 */
import { parseEventDetails, type SessionEventDetails } from '@vaubaan/shared';

import { GATE_WORDS, gateWordOf } from '@/lib/vocabulary';

/** What kind of line it is: it chooses the mark, and its word for assistive technology. */
export type EventTone = 'ok' | 'bad' | 'warn' | 'neutral';

export interface EventWords {
  readonly tone: EventTone;
  /**
   * What happened, without the identifiers. For a call it is a verb phrase that
   * follows who called ("ran", "was stopped on"), and the tool follows it.
   */
  readonly text: string;
  /** The event is a call: the sentence starts with who made it. */
  readonly call: boolean;
  /** The tool of a call, as the protocol spells it. */
  readonly tool: string | null;
  /** The refusal code of a refused call, as the protocol spells it. */
  readonly code: string | null;
  /** What the agent said about itself; never verified. */
  readonly agent: string | null;
  /** An instant the sentence ends with ("valid until", "until"): the page renders it locally. */
  readonly until: string | null;
}

export interface WordedEvent {
  readonly kind: string;
  readonly details: Readonly<Record<string, unknown>> | null;
}

const PLAIN = { tool: null, code: null, agent: null, until: null, call: false } as const;

/** The refusals that ask something of the creator: the call waits, it did not fail. */
const ASKING: readonly string[] = ['approval-required', 'budget-exhausted'];

function worded(parsed: SessionEventDetails): EventWords {
  switch (parsed.kind) {
    case 'call-allowed':
      return {
        ...PLAIN,
        tone: 'ok',
        call: true,
        text: parsed.details.approval_ids.length > 0 ? 'ran, with your yes,' : 'ran',
        tool: parsed.details.tool || null,
        agent: parsed.details.agent_label,
      };
    case 'call-refused': {
      const asking = ASKING.includes(parsed.details.refusal_code);
      return {
        ...PLAIN,
        tone: asking ? 'warn' : 'bad',
        call: true,
        text: asking ? 'was stopped on' : 'was refused',
        tool: parsed.details.tool || null,
        code: parsed.details.refusal_code,
        agent: parsed.details.agent_label,
      };
    }
    case 'request': {
      const { details } = parsed;
      if ('state' in details) {
        return {
          ...PLAIN,
          tone: 'neutral',
          text:
            details.state === 'expired'
              ? 'The request expired without an answer'
              : 'You refused the request',
        };
      }
      return {
        ...PLAIN,
        tone: 'warn',
        text:
          details.request_kind === 'approval'
            ? 'Asked you before running'
            : 'Asked you for more room after a limit was reached',
        tool: details.request_kind === 'approval' ? details.tool || null : null,
      };
    }
    case 'reset':
      return { ...PLAIN, tone: 'neutral', text: 'You reset the count of this permission' };
    case 'extension':
      if (parsed.details.dimension === 'expiry') {
        return {
          ...PLAIN,
          tone: 'neutral',
          text: 'You extended the mission until',
          until: parsed.details.expires_at,
        };
      }
      return {
        ...PLAIN,
        tone: 'neutral',
        text:
          parsed.details.amount === 1
            ? 'You gave back 1 call until the reset'
            : `You gave back ${parsed.details.amount} calls until the reset`,
      };
    case 'approval':
      return {
        ...PLAIN,
        tone: 'neutral',
        text: 'You approved one call, valid until',
        tool: parsed.details.tool || null,
        until: parsed.details.expires_at,
      };
    case 'gate-opened':
      return {
        ...PLAIN,
        tone: 'neutral',
        text: 'You let this permission run freely until',
        until: parsed.details.period_end,
      };
    case 'gate-changed':
      return {
        ...PLAIN,
        tone: 'neutral',
        text: `You set this permission to “${GATE_WORDS[gateWordOf(parsed.details.gate)]}”`,
      };
    case 'rotation':
      return {
        ...PLAIN,
        tone: 'neutral',
        text:
          parsed.details.token_kind && !parsed.details.replaced_prefix
            ? 'A key was created'
            : 'A key was replaced',
      };
    case 'revocation':
      return {
        ...PLAIN,
        tone: 'neutral',
        text: parsed.details.token_prefix ? 'A key was revoked' : 'The mission was stopped',
      };
  }
}

const WITHOUT_DETAIL: Readonly<Record<string, Pick<EventWords, 'tone' | 'text'>>> = {
  'call-allowed': { tone: 'ok', text: 'A call ran' },
  'call-refused': { tone: 'bad', text: 'A call was refused' },
  request: { tone: 'neutral', text: 'A request changed' },
  reset: { tone: 'neutral', text: 'You reset the count of this permission' },
  extension: { tone: 'neutral', text: 'You gave the mission more room' },
  approval: { tone: 'neutral', text: 'You approved one call' },
  'gate-opened': { tone: 'neutral', text: 'You let a permission run freely until the reset' },
  'gate-changed': { tone: 'neutral', text: 'You changed what a permission asks' },
  rotation: { tone: 'neutral', text: 'A key was replaced' },
  revocation: { tone: 'neutral', text: 'The mission was stopped' },
};

/** Total: an unknown kind (a later feature's) reads as its bare kind. */
export function eventWords(event: WordedEvent): EventWords {
  const parsed = parseEventDetails(event.kind, event.details);
  if (parsed) return worded(parsed);
  const fallback = WITHOUT_DETAIL[event.kind];
  return { ...PLAIN, ...(fallback ?? { tone: 'neutral', text: event.kind }) };
}
