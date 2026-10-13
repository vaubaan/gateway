/**
 * The Detail column of the session timeline, kind by kind: `eventView` over a
 * stored event, then `eventDetailLines` (spec §4.2 "Mission session").
 */
import { describe, expect, it } from 'vitest';

import type { EventRecord } from '../store/types';
import { eventDetailLines, isSessionEventKind } from './session-event-detail';
import { eventView } from './session-view';

const RISK = 'github.merge-protected';
const LATER = '2026-10-14T00:00:00.000Z';

function stored(kind: string, details: EventRecord['details']): EventRecord {
  return {
    id: 'e-1',
    sessionId: 's-1',
    ts: '2026-10-13T09:00:00.000Z',
    kind,
    riskId: RISK,
    actorUserId: null,
    details,
  };
}

const linesOf = (kind: string, details: EventRecord['details'], requestOpen = false) =>
  eventDetailLines(eventView(stored(kind, details), null), { requestOpen });

const text = (value: string, at: string | null = null) => ({ text: value, at, mono: false });
const mono = (value: string) => ({ text: value, at: null, mono: true });

const CALL = { tool: 'github__merge_pull_request', fingerprint: 'sha256:a', risk_ids: [RISK] };

describe('eventDetailLines', () => {
  it('an allowed call says when it consumed an approval, and nothing otherwise', () => {
    const allowed = { ...CALL, agent_label: null, remaining: { [RISK]: 1 } };
    expect(linesOf('call-allowed', { ...allowed, approval_ids: [] })).toEqual([]);
    expect(linesOf('call-allowed', { ...allowed, approval_ids: ['a-1'] })).toEqual([
      text('approval consumed'),
    ]);
  });

  it('a refused call names the request it pointed to once that request is closed', () => {
    const refused = (code: string, requestId: string | null) => ({
      ...CALL,
      agent_label: null,
      refusal_code: code,
      request_id: requestId,
    });
    // Open: the page shows the link, this module adds nothing.
    expect(linesOf('call-refused', refused('budget-exhausted', 'r-1'), true)).toEqual([]);
    expect(linesOf('call-refused', refused('budget-exhausted', 'r-1'))).toEqual([
      text('claim (closed)'),
    ]);
    expect(linesOf('call-refused', refused('approval-required', 'r-2'))).toEqual([
      text('approval request (closed)'),
    ]);
    // A rate-limited call asks nothing of the creator.
    expect(linesOf('call-refused', refused('rate-limited', null))).toEqual([]);
  });

  it('a request event says whether it was asked, refused or left to expire', () => {
    const dropped = { request_id: 'r-1', tool: 'github__merge_pull_request', fingerprint: 'f' };
    expect(linesOf('request', { ...dropped, request_kind: 'claim' }, true)).toEqual([
      text('claim asked'),
    ]);
    expect(linesOf('request', { ...dropped, request_kind: 'approval' })).toEqual([
      text('approval request asked (closed)'),
    ]);
    expect(
      linesOf('request', { request_id: 'r-1', request_kind: 'claim', state: 'refused' }),
    ).toEqual([text('claim refused by the creator')]);
    expect(
      linesOf('request', { request_id: 'r-1', request_kind: 'approval', state: 'expired' }),
    ).toEqual([text('approval request expired unanswered')]);
  });

  it('an approval says until when the approved call can be replayed', () => {
    expect(
      linesOf('approval', {
        request_id: 'r-1',
        approval_id: 'a-1',
        tool: 'github__merge_pull_request',
        fingerprint: 'f',
        expires_at: LATER,
      }),
    ).toEqual([text('one call approved, usable until', LATER)]);
  });

  it('a gate opening says until when, a gate edit says both gates', () => {
    expect(
      linesOf('gate-opened', {
        request_id: 'r-1',
        period_start: '2026-10-13T00:00:00.000Z',
        period_end: LATER,
      }),
    ).toEqual([text('gate open until', LATER)]);
    expect(linesOf('gate-changed', { gate: 'auto', gate_before: 'approval' })).toEqual([
      text('gate set to auto (was approval)'),
    ]);
  });

  it('a reset and a quota extension list what was given back; an expiry extension the new expiry', () => {
    const period = { period_start: '2026-10-13T00:00:00.000Z', period_end: LATER };
    expect(
      linesOf('reset', {
        request_id: 'r-1',
        ...period,
        credits: { [RISK]: 2, 'github.read-code': 1 },
      }),
    ).toEqual([mono(`${RISK} +2 given back`), mono('github.read-code +1 given back')]);
    expect(
      linesOf('extension', {
        request_id: 'r-1',
        dimension: 'quota',
        amount: 1,
        ...period,
        credits: { [RISK]: 1 },
      }),
    ).toEqual([mono(`${RISK} +1 given back`)]);
    expect(
      linesOf('extension', {
        request_id: 'r-1',
        dimension: 'expiry',
        expires_at_before: null,
        expires_at: LATER,
      }),
    ).toEqual([text('expiry moved to', LATER)]);
  });

  it('a rotation shows the token prefix, a revocation how many tokens it retired', () => {
    expect(linesOf('rotation', { token_prefix: 'AbCd1234' })).toEqual([mono('token AbCd1234…')]);
    expect(linesOf('revocation', { tokens_revoked: 1 })).toEqual([text('1 token revoked')]);
    expect(linesOf('revocation', { tokens_revoked: 2 })).toEqual([text('2 tokens revoked')]);
  });

  it('shows nothing for malformed details or a kind of a later version', () => {
    expect(linesOf('gate-opened', { period_end: 7 })).toEqual([]);
    expect(linesOf('approval', null)).toEqual([]);
    expect(linesOf('some-later-kind', { anything: 'x' })).toEqual([]);
    expect(isSessionEventKind('some-later-kind')).toBe(false);
    expect(isSessionEventKind('gate-changed')).toBe(true);
    // A property of every object is not a kind.
    expect(isSessionEventKind('toString')).toBe(false);
  });
});
