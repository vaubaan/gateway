import { describe, expect, it } from 'vitest';

import { describeEvent, eventLineOf, type SessionEventLike } from './events';

function event(kind: string, details: Record<string, unknown> | null = null): SessionEventLike {
  return {
    id: 'e1',
    ts: '2026-10-13T09:00:00.000Z',
    kind,
    riskId: null,
    actorUserId: null,
    details,
  };
}

/** Stored details as the writers build them (`SessionEventDetails`, `@vaubaan/shared`). */
const CALL = {
  tool: 'github__push',
  fingerprint: 'sha256:abc',
  risk_ids: ['github.code-write'],
  agent_label: null,
};
const DROPPED = { request_id: 'r1', tool: 'github__push', fingerprint: 'sha256:abc' };
const SPAN = { period_start: '2026-10-13T00:00:00.000Z', period_end: null };
const quotaExtension = (amount: number): Record<string, unknown> => ({
  request_id: 'r1',
  dimension: 'quota',
  amount,
  ...SPAN,
  credits: { 'github.code-write': amount },
});

describe('describeEvent', () => {
  it('names the tool, the refusal code and the agent label of a call', () => {
    expect(
      describeEvent(
        event('call-allowed', {
          ...CALL,
          tool: 'github__get_file',
          remaining: { 'github.code-write': 2 },
          approval_ids: [],
        }),
      ),
    ).toBe('Allowed github__get_file');
    expect(
      describeEvent(
        event('call-refused', {
          ...CALL,
          refusal_code: 'budget-exhausted',
          request_id: 'r1',
          agent_label: 'reviewer',
        }),
      ),
    ).toBe('Refused github__push (budget-exhausted) by “reviewer”');
  });

  it('tells a dropped request from a refused or expired one', () => {
    expect(describeEvent(event('request', { ...DROPPED, request_kind: 'claim' }))).toContain(
      'claim was dropped',
    );
    expect(describeEvent(event('request', { ...DROPPED, request_kind: 'approval' }))).toContain(
      'approval request was dropped',
    );
    expect(
      describeEvent(
        event('request', { request_id: 'r1', request_kind: 'claim', state: 'refused' }),
      ),
    ).toBe('The creator refused the claim');
    expect(
      describeEvent(
        event('request', { request_id: 'r1', request_kind: 'claim', state: 'expired' }),
      ),
    ).toBe('The claim expired unanswered');
  });

  it('describes the creator’s grants', () => {
    expect(
      describeEvent(event('reset', { request_id: 'r1', ...SPAN, credits: { 'github.x': 2 } })),
    ).toContain('reset the period');
    expect(describeEvent(event('extension', quotaExtension(1)))).toBe(
      'The creator gave back 1 action for the period',
    );
    expect(describeEvent(event('extension', quotaExtension(3)))).toContain('3 actions');
    expect(
      describeEvent(
        event('extension', {
          request_id: 'r1',
          dimension: 'expiry',
          expires_at_before: null,
          expires_at: '2026-11-01T00:00:00.000Z',
        }),
      ),
    ).toBe('The creator extended the expiry to 2026-11-01T00:00:00.000Z');
  });

  it('is total: details missing, or a kind a later feature adds', () => {
    expect(describeEvent(event('call-allowed'))).toBe('Allowed a tool');
    expect(describeEvent(event('extension'))).toBe('The creator extended the mission');
    expect(describeEvent(event('gate-opened'))).toBe('gate-opened');
    expect(describeEvent(event('rotation'))).toContain('rotated');
    expect(describeEvent(event('revocation'))).toContain('revoked');
  });

  it('shows an event with malformed details without detail, and does not throw', () => {
    // A renamed key (`toolName`), a wrong type, a state no writer produces.
    expect(describeEvent(event('call-allowed', { ...CALL, tool: undefined, toolName: 'x' }))).toBe(
      'Allowed a tool',
    );
    expect(describeEvent(event('call-refused', { ...CALL, refusal_code: 42 }))).toBe(
      'Refused a tool',
    );
    expect(
      describeEvent(
        event('request', { request_id: 'r1', request_kind: 'claim', state: 'granted' }),
      ),
    ).toBe('A request changed state');
    expect(describeEvent(event('extension', { ...quotaExtension(2), amount: 'two' }))).toBe(
      'The creator extended the mission',
    );
    expect(describeEvent(event('reset', { credits: 'all' }))).toContain('reset the period');
  });

  it('maps a record to a line', () => {
    expect(eventLineOf({ ...event('reset'), riskId: 'github.code-read' })).toEqual({
      id: 'e1',
      at: '2026-10-13T09:00:00.000Z',
      kind: 'reset',
      risk_id: 'github.code-read',
      summary: describeEvent(event('reset')),
    });
  });
});
