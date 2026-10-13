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

describe('describeEvent', () => {
  it('names the tool, the refusal code and the agent label of a call', () => {
    expect(describeEvent(event('call-allowed', { tool: 'github__get_file' }))).toBe(
      'Allowed github__get_file',
    );
    expect(
      describeEvent(
        event('call-refused', {
          tool: 'github__push',
          refusal_code: 'budget-exhausted',
          agent_label: 'reviewer',
        }),
      ),
    ).toBe('Refused github__push (budget-exhausted) by “reviewer”');
  });

  it('tells a dropped request from a refused or expired one', () => {
    expect(describeEvent(event('request', { request_kind: 'claim' }))).toContain(
      'claim was dropped',
    );
    expect(describeEvent(event('request', { request_kind: 'approval' }))).toContain(
      'approval request was dropped',
    );
    expect(describeEvent(event('request', { request_kind: 'claim', state: 'refused' }))).toBe(
      'The creator refused the claim',
    );
    expect(describeEvent(event('request', { request_kind: 'claim', state: 'expired' }))).toBe(
      'The claim expired unanswered',
    );
  });

  it('describes the creator’s grants', () => {
    expect(describeEvent(event('reset'))).toContain('reset the period');
    expect(describeEvent(event('extension', { dimension: 'quota', amount: 1 }))).toBe(
      'The creator gave back 1 action for the period',
    );
    expect(describeEvent(event('extension', { dimension: 'quota', amount: 3 }))).toContain(
      '3 actions',
    );
    expect(
      describeEvent(
        event('extension', { dimension: 'expiry', expires_at: '2026-11-01T00:00:00.000Z' }),
      ),
    ).toBe('The creator extended the expiry to 2026-11-01T00:00:00.000Z');
  });

  it('is total: details missing, or a kind a later feature adds', () => {
    expect(describeEvent(event('call-allowed'))).toBe('Allowed a tool');
    expect(describeEvent(event('extension'))).toContain('extended the quota');
    expect(describeEvent(event('gate-opened'))).toBe('gate-opened');
    expect(describeEvent(event('rotation'))).toContain('rotated');
    expect(describeEvent(event('revocation'))).toContain('revoked');
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
