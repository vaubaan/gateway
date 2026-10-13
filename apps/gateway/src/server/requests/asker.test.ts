import { describe, expect, it } from 'vitest';

import { askedBy } from './asker';
import type { SessionEventLike } from './events';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

let serial = 0;
function refusedCall(
  ts: string,
  details: Record<string, unknown>,
  kind = 'call-refused',
): SessionEventLike {
  serial += 1;
  return {
    id: `e${serial}`,
    ts,
    kind,
    riskId: 'github.code-read',
    actorUserId: null,
    details: {
      tool: 'github__get_file_contents',
      fingerprint: 'sha256:abc',
      risk_ids: ['github.code-read'],
      agent_label: null,
      refusal_code: 'budget-exhausted',
      request_id: REQUEST,
      ...details,
    },
  };
}

describe('askedBy', () => {
  it('names the holder and the label of the first refused call that points to the request', () => {
    const asked = askedBy(
      [
        refusedCall('2026-10-13T10:05:00.000Z', {
          token_kind: 'named',
          holder: 'nightly',
          agent_label: 'replay',
        }),
        refusedCall('2026-10-13T10:00:00.000Z', {
          token_kind: 'member',
          holder: 'user-carol',
          agent_label: 'codex',
        }),
      ],
      REQUEST,
    );
    expect(asked).toEqual({
      token_kind: 'member',
      holder: 'user-carol',
      agent_label: 'codex',
      tool: 'github__get_file_contents',
      refused_calls: 2,
    });
  });

  it('ignores the calls of another request, the allowed calls and the refusals that ask nothing', () => {
    const asked = askedBy(
      [
        refusedCall('2026-10-13T09:00:00.000Z', { request_id: OTHER, agent_label: 'other' }),
        refusedCall('2026-10-13T09:01:00.000Z', { request_id: null, agent_label: 'nobody' }),
        refusedCall('2026-10-13T09:02:00.000Z', { agent_label: 'allowed' }, 'call-allowed'),
        refusedCall('2026-10-13T09:03:00.000Z', { agent_label: 'the one' }),
      ],
      REQUEST,
    );
    expect(asked).toMatchObject({ agent_label: 'the one', refused_calls: 1 });
  });

  it('an event recorded before tokens had a holder has no holder, and still a label', () => {
    expect(
      askedBy([refusedCall('2026-10-13T09:00:00.000Z', { agent_label: 'old' })], REQUEST),
    ).toEqual({
      token_kind: null,
      holder: null,
      agent_label: 'old',
      tool: 'github__get_file_contents',
      refused_calls: 1,
    });
  });

  it('answers null when no event points to the request, and for details it cannot read', () => {
    expect(askedBy([], REQUEST)).toBeNull();
    expect(
      askedBy([refusedCall('2026-10-13T09:00:00.000Z', { request_id: OTHER })], REQUEST),
    ).toBeNull();
    const unreadable: SessionEventLike = {
      id: 'x',
      ts: '2026-10-13T09:00:00.000Z',
      kind: 'call-refused',
      riskId: null,
      actorUserId: null,
      details: { request_id: REQUEST },
    };
    expect(askedBy([unreadable], REQUEST)).toBeNull();
  });
});
