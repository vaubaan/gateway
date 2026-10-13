/**
 * What the activity of a mission says of one event, in the words of the
 * interface (spec §4.2 "Mission session — event timeline"). Pure, over the
 * typed fields of `SessionEventView`, so the wording is tested without a
 * browser.
 *
 * An event has a short outcome — "allowed", "refused", "asked first", "key
 * replaced" — a tone only when it is an exception (red: refused or stopped;
 * amber: something asks the creator), and a few lines of detail. A date is a
 * field and not part of a text: the page prints it in the reader's time zone.
 * Protocol names (refusal codes, permission ids, key prefixes) are marked
 * `mono` and printed as the protocol spells them.
 */
import type { SessionEventKind } from '@vaubaan/shared';

import { GATE_WORDS, gateWordOf } from '@/lib/vocabulary';
import type { SessionEventView } from '@/server/audit';

export interface EventLine {
  readonly text: string;
  /** An instant printed after the text; `null` when the line has none. */
  readonly at: string | null;
  readonly mono: boolean;
}

export interface EventWords {
  readonly outcome: string;
  readonly tone: 'bad' | 'warn' | null;
  readonly lines: readonly EventLine[];
}

const line = (text: string, at: string | null = null): EventLine => ({ text, at, mono: false });
const identifier = (text: string): EventLine => ({ text, at: null, mono: true });

/** What a refusal means for the person reading, by the protocol's code. */
const REFUSAL_OUTCOME: Readonly<Record<string, { outcome: string; tone: 'bad' | 'warn' }>> = {
  'approval-required': { outcome: 'asked first', tone: 'warn' },
  'budget-exhausted': { outcome: 'limit reached', tone: 'bad' },
  'rate-limited': { outcome: 'too fast', tone: 'bad' },
};

function creditLines(event: SessionEventView): EventLine[] {
  return Object.entries(event.credits ?? {}).map(([risk, given]) =>
    identifier(`${risk} +${given} given back`),
  );
}

function keyLines(event: SessionEventView): EventLine[] {
  if (!event.token_prefix) return [];
  // Whose key it is stands in the "Who" column of the row.
  return [identifier(`vbn_live_${event.token_prefix}_…`)];
}

const KNOWN: Readonly<Record<SessionEventKind, true>> = {
  'call-allowed': true,
  'call-refused': true,
  request: true,
  extension: true,
  reset: true,
  approval: true,
  'gate-opened': true,
  'gate-changed': true,
  rotation: true,
  revocation: true,
};

function isKnown(kind: string): kind is SessionEventKind {
  return Object.hasOwn(KNOWN, kind);
}

/**
 * `requestOpen`: the request the event names still waits for the creator (the
 * page then links to it, or says who it waits for).
 */
export function eventWords(
  event: SessionEventView,
  options: { readonly requestOpen: boolean },
): EventWords {
  // A kind written by a later version is printed as it is stored.
  if (!isKnown(event.kind)) return { outcome: event.kind, tone: null, lines: [] };
  const answered = event.request_id !== null && !options.requestOpen;
  switch (event.kind) {
    case 'call-allowed':
      return {
        outcome: 'allowed',
        tone: null,
        lines: event.approvals_consumed > 0 ? [line('after the creator’s yes')] : [],
      };
    case 'call-refused': {
      const known = event.refusal_code ? REFUSAL_OUTCOME[event.refusal_code] : undefined;
      const lines: EventLine[] = event.refusal_code ? [identifier(event.refusal_code)] : [];
      if (answered) lines.push(line('the request it opened is closed'));
      return { outcome: known?.outcome ?? 'refused', tone: known?.tone ?? 'bad', lines };
    }
    case 'request': {
      const what = event.request_kind === 'claim' ? 'asked for more room' : 'asked for a yes';
      if (event.request_state === 'refused') {
        return { outcome: 'refused by the creator', tone: null, lines: [line(what)] };
      }
      if (event.request_state === 'expired') {
        return { outcome: 'expired unanswered', tone: null, lines: [line(what)] };
      }
      return {
        outcome: what,
        tone: answered ? null : 'warn',
        lines: answered ? [line('answered since')] : [],
      };
    }
    case 'approval':
      return {
        outcome: 'approved',
        tone: null,
        lines: event.expires_at ? [line('one call, usable until', event.expires_at)] : [],
      };
    case 'gate-opened':
      return {
        outcome: GATE_WORDS.free,
        tone: null,
        lines: event.gate_open_until ? [line('without asking until', event.gate_open_until)] : [],
      };
    case 'gate-changed':
      return {
        outcome: event.gate ? `set to “${GATE_WORDS[gateWordOf(event.gate)]}”` : 'changed',
        tone: null,
        lines: event.gate_before
          ? [line(`was “${GATE_WORDS[gateWordOf(event.gate_before)]}”`)]
          : [],
      };
    case 'reset':
      return { outcome: 'limits reset', tone: null, lines: creditLines(event) };
    case 'extension':
      return event.dimension === 'expiry' && event.expires_at
        ? { outcome: 'given more time', tone: null, lines: [line('ends', event.expires_at)] }
        : { outcome: 'limit raised', tone: null, lines: creditLines(event) };
    case 'rotation': {
      const lines = keyLines(event);
      if (event.replaced_prefix) {
        lines.push(identifier(`replaces vbn_live_${event.replaced_prefix}_…`));
      }
      return {
        outcome: event.replaced_prefix ? 'key replaced' : 'key generated',
        tone: null,
        lines,
      };
    }
    case 'revocation': {
      // One key revoked on its own names it; a mission that was stopped counts them.
      if (event.token_prefix)
        return { outcome: 'key revoked', tone: 'bad', lines: keyLines(event) };
      const revoked = event.tokens_revoked;
      return {
        outcome: 'mission stopped',
        tone: 'bad',
        lines:
          revoked === null ? [] : [line(`${revoked} ${revoked === 1 ? 'key' : 'keys'} revoked`)],
      };
    }
  }
}
