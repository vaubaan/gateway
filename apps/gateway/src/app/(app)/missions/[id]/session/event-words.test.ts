import { describe, expect, it } from 'vitest';

import type { SessionEventView } from '@/server/audit';

import { eventWords } from './event-words';

function event(kind: string, over: Partial<SessionEventView> = {}): SessionEventView {
  return {
    id: 'e1',
    ts: '2026-10-13T09:00:00.000Z',
    kind,
    risk_ids: [],
    actor_email: null,
    tool: null,
    refusal_code: null,
    agent_label: null,
    holder: null,
    remaining: null,
    request_id: null,
    request_kind: null,
    request_state: null,
    approvals_consumed: 0,
    gate: null,
    gate_before: null,
    gate_open_until: null,
    limits: null,
    created_refs: null,
    permission: null,
    mission_change: null,
    request_reason: null,
    tokens_revoked: null,
    token_prefix: null,
    replaced_prefix: null,
    credits: null,
    dimension: null,
    expires_at: null,
    ...over,
  };
}

const words = (e: SessionEventView, requestOpen = false) => eventWords(e, { requestOpen });

describe('what the activity of a mission says of an event', () => {
  it('says the mission reached what it created, with the refs (ADR created-resources-join-the-mission)', () => {
    expect(
      words(event('resources-created', { tool: 'miro__board_create', created_refs: ['uXj~'] })),
    ).toMatchObject({ outcome: 'reached a resource it created', tone: null });
    expect(words(event('resources-created', { created_refs: ['a', 'b'] })).outcome).toBe(
      'reached the resources it created',
    );
  });

  it('says an edit of the mission in one line per clause', () => {
    const changed = words(
      event('mission-changed', {
        mission_change: [
          '2 resources added',
          '1 permission removed',
          'quota of github.read 200 → 500',
        ],
      }),
    );
    expect(changed.outcome).toBe('changed the mission');
    expect(changed.lines.map((l) => l.text)).toEqual([
      '2 resources added',
      '1 permission removed',
      'quota of github.read 200 → 500',
    ]);
  });

  it('says a permission added with its limits, and a permission removed', () => {
    const added = words(
      event('permission-added', {
        permission: { quota: 50, rate_limit_max: 10, rate_window_seconds: 60, gate: 'approval' },
      }),
    );
    expect(added.outcome).toBe('permission added');
    expect(added.lines.map((l) => l.text)).toEqual([
      '50 a period',
      '10 per 60 s',
      '“ask me first”',
    ]);
    expect(words(event('permission-removed')).outcome).toBe('permission removed');
  });

  it('says a request closed by an edit, not refused', () => {
    const closed = words(
      event('request', {
        request_kind: 'claim',
        request_state: 'refused',
        request_reason: 'mission-changed',
      }),
    );
    expect(closed.outcome).toBe('closed by your edit');
  });

  it('says a change of limits with the values before and after', () => {
    const changed = words(
      event('limits-changed', {
        limits: { quota: 5, quota_before: 20, rate_limit_max: 2, rate_limit_max_before: 10 },
      }),
    );
    expect(changed.outcome).toBe('limits changed');
    expect(changed.lines.map((l) => l.text)).toEqual(['20 → 5 a period', '10 → 2 per rate window']);
  });

  it('writes an allowed call plainly, and says when it ran after a yes', () => {
    expect(words(event('call-allowed'))).toEqual({ outcome: 'allowed', tone: null, lines: [] });
    expect(words(event('call-allowed', { approvals_consumed: 1 })).lines[0]?.text).toBe(
      'after the creator’s yes',
    );
  });

  it('colours a refusal, says what it means, and prints its code as the protocol spells it', () => {
    const refused = words(event('call-refused', { refusal_code: 'risk-not-accepted' }));
    expect(refused).toMatchObject({ outcome: 'refused', tone: 'bad' });
    expect(refused.lines).toEqual([{ text: 'risk-not-accepted', at: null, mono: true }]);
    expect(words(event('call-refused', { refusal_code: 'budget-exhausted' }))).toMatchObject({
      outcome: 'limit reached',
      tone: 'bad',
    });
    // A call that asked first needs a person, it was not stopped: amber, not red.
    expect(words(event('call-refused', { refusal_code: 'approval-required' }))).toMatchObject({
      outcome: 'asked first',
      tone: 'warn',
    });
  });

  it('says what was asked, and stops colouring it once it is answered', () => {
    const asked = event('request', { request_id: 'r1', request_kind: 'approval' });
    expect(words(asked, true)).toMatchObject({ outcome: 'asked for a yes', tone: 'warn' });
    expect(words(asked, false)).toMatchObject({ outcome: 'asked for a yes', tone: null });
    expect(words(event('request', { request_id: 'r1', request_kind: 'claim' }), true).outcome).toBe(
      'asked for more room',
    );
    expect(
      words(event('request', { request_id: 'r1', request_kind: 'claim', request_state: 'refused' }))
        .outcome,
    ).toBe('refused by the creator');
    expect(
      words(event('request', { request_id: 'r1', request_kind: 'claim', request_state: 'expired' }))
        .outcome,
    ).toBe('expired unanswered');
  });

  it('says a gate in the words of the interface, never "auto" or "approval"', () => {
    const changed = words(event('gate-changed', { gate: 'approval', gate_before: 'auto' }));
    expect(changed.outcome).toBe('set to “ask me first”');
    expect(changed.lines[0]?.text).toBe('was “runs freely”');
    const opened = words(event('gate-opened', { gate_open_until: '2026-10-14T00:00:00.000Z' }));
    expect(opened.outcome).toBe('runs freely');
    expect(opened.lines[0]).toEqual({
      text: 'without asking until',
      at: '2026-10-14T00:00:00.000Z',
      mono: false,
    });
  });

  it('says what an answer gave: a yes, a reset, a raised limit, more time', () => {
    expect(words(event('approval', { expires_at: '2026-10-13T09:10:00.000Z' }))).toMatchObject({
      outcome: 'approved',
      lines: [{ text: 'one call, usable until', at: '2026-10-13T09:10:00.000Z' }],
    });
    expect(words(event('reset', { credits: { 'acme.read': 5 } }))).toMatchObject({
      outcome: 'limits reset',
      lines: [{ text: 'acme.read +5 given back', mono: true }],
    });
    expect(words(event('extension', { credits: { 'acme.read': 2 } })).outcome).toBe('limit raised');
    expect(
      words(event('extension', { dimension: 'expiry', expires_at: '2026-11-01T00:00:00.000Z' })),
    ).toMatchObject({ outcome: 'given more time', lines: [{ text: 'ends' }] });
  });

  it('names a key by its masked form, and tells a replaced key from a first one', () => {
    const first = words(event('rotation', { token_prefix: 'AbCd1234' }));
    expect(first.outcome).toBe('key generated');
    expect(first.lines).toEqual([{ text: 'vbn_live_AbCd1234_…', at: null, mono: true }]);
    const replaced = words(
      event('rotation', { token_prefix: 'AbCd1234', replaced_prefix: 'ZyXw9876' }),
    );
    expect(replaced.outcome).toBe('key replaced');
    expect(replaced.lines[1]?.text).toBe('replaces vbn_live_ZyXw9876_…');
  });

  it('tells one key revoked from a mission stopped', () => {
    expect(
      words(event('revocation', { token_prefix: 'AbCd1234', tokens_revoked: 1 })),
    ).toMatchObject({ outcome: 'key revoked', tone: 'bad' });
    expect(words(event('revocation', { tokens_revoked: 3 }))).toMatchObject({
      outcome: 'mission stopped',
      lines: [{ text: '3 keys revoked' }],
    });
  });

  it('prints a kind a later version wrote as it is stored', () => {
    expect(words(event('a-later-kind'))).toEqual({
      outcome: 'a-later-kind',
      tone: null,
      lines: [],
    });
  });
});
