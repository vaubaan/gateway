/**
 * What the Detail column of the session timeline says of one event (spec §4.2
 * "Mission session — event timeline … gate per risk, open requests").
 *
 * Pure, over the typed fields of `SessionEventView`: the page renders the
 * lines and nothing else, so the wording is tested here without a browser. A
 * line is a short text, optionally followed by an instant the page prints in
 * the reader's time zone (`LocalDate`), which is why a date is a field and not
 * part of the text.
 *
 * The switch is over `SessionEventKind` with no `default`: a new kind fails to
 * compile until it says what it shows. `describeEvent` (`server/requests/events.ts`)
 * words the same events as sentences for the request page; keep the two aligned.
 *
 * The link to an open request is the page's (`open claim`, `open approval`):
 * this module only names a request that is no longer open.
 */
import type { RequestKind, SessionEventKind } from '@vaubaan/shared';

import type { SessionEventView } from './session-view';

export interface EventDetailLine {
  readonly text: string;
  /** An instant printed after the text; `null` when the line has none. */
  readonly at: string | null;
  /** Identifiers (risk ids, token prefixes) are set in the monospace face. */
  readonly mono: boolean;
}

const SESSION_EVENT_KINDS: Readonly<Record<SessionEventKind, true>> = {
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

/** A stored kind this version knows; a later version's kind is not one. */
export function isSessionEventKind(kind: string): kind is SessionEventKind {
  return Object.hasOwn(SESSION_EVENT_KINDS, kind);
}

const line = (text: string, at: string | null = null): EventDetailLine => ({
  text,
  at,
  mono: false,
});

const identifier = (text: string): EventDetailLine => ({ text, at: null, mono: true });

/** `claim`, `approval request`: the kind as the page names it. */
function nameOf(kind: RequestKind | null): string {
  if (kind === 'approval') return 'approval request';
  return kind ?? 'request';
}

/** `member bob@acme.test`, `named token "CI runner"`. */
function holderPhrase(holder: NonNullable<SessionEventView['holder']>): string {
  return holder.kind === 'member' ? `member ${holder.label}` : `named token "${holder.label}"`;
}

function creditLines(event: SessionEventView): EventDetailLine[] {
  return Object.entries(event.credits ?? {}).map(([risk, given]) =>
    identifier(`${risk} +${given} given back`),
  );
}

/**
 * The lines of the Detail column. `requestOpen`: the request the event names
 * is still waiting in the creator's inbox (the page then links to it).
 */
export function eventDetailLines(
  event: SessionEventView,
  options: { readonly requestOpen: boolean },
): EventDetailLine[] {
  if (!isSessionEventKind(event.kind)) return [];
  const closed = event.request_id !== null && !options.requestOpen;
  switch (event.kind) {
    case 'call-allowed':
      return event.approvals_consumed > 0 ? [line('approval consumed')] : [];
    case 'call-refused':
      return closed ? [line(`${nameOf(event.request_kind)} (closed)`)] : [];
    case 'request': {
      if (event.request_id === null) return [];
      const name = nameOf(event.request_kind);
      if (event.request_state === 'refused') return [line(`${name} refused by the creator`)];
      if (event.request_state === 'expired') return [line(`${name} expired unanswered`)];
      return [line(closed ? `${name} asked (closed)` : `${name} asked`)];
    }
    case 'approval':
      return event.expires_at ? [line('one call approved, usable until', event.expires_at)] : [];
    case 'gate-opened':
      return event.gate_open_until ? [line('gate open until', event.gate_open_until)] : [];
    case 'gate-changed':
      return event.gate && event.gate_before
        ? [line(`gate set to ${event.gate} (was ${event.gate_before})`)]
        : [];
    case 'reset':
      return creditLines(event);
    case 'extension':
      return event.dimension === 'expiry' && event.expires_at
        ? [line('expiry moved to', event.expires_at)]
        : creditLines(event);
    case 'rotation': {
      if (!event.token_prefix) return [];
      const lines = [identifier(`token ${event.token_prefix}…`)];
      if (event.holder) lines.push(line(`${holderPhrase(event.holder)}`));
      if (event.replaced_prefix) lines.push(identifier(`replaces ${event.replaced_prefix}…`));
      return lines;
    }
    case 'revocation': {
      const count = event.tokens_revoked;
      if (count === null) return [];
      // One token revoked on its own names it; a mission revoked counts them.
      if (event.token_prefix) {
        const lines = [identifier(`token ${event.token_prefix}… revoked`)];
        if (event.holder) lines.push(line(holderPhrase(event.holder)));
        return lines;
      }
      return [line(`${count} ${count === 1 ? 'token' : 'tokens'} revoked`)];
    }
  }
}
