/**
 * What the page that waits for the first call reads in the gateway's answer (spec §7.4):
 * nothing yet, connected, or a first call with its outcome; a refusal is never read as a
 * plain arrival.
 */
import { describe, expect, it } from 'vitest';

import { seenOf } from '../../../src/app/(app)/missions/first-call-wait';

describe('the first call, as the page reads it', () => {
  it('waits while the key was never used', () => {
    expect(seenOf({ called_at: null, first: null })).toEqual({ state: 'waiting' });
  });

  it('says connected once the key was used and no tool was called', () => {
    expect(seenOf({ called_at: '2026-11-27T10:00:00.000Z', first: null })).toEqual({
      state: 'connected',
    });
  });

  it('keeps a refused first call refused, with its tool and code', () => {
    expect(
      seenOf({
        called_at: '2026-11-27T10:00:00.000Z',
        first: {
          at: '2026-11-27T10:00:00.000Z',
          outcome: 'refused',
          tool: 'github__create_branch',
          refusal_code: 'risk-not-accepted',
        },
      }),
    ).toEqual({
      state: 'called',
      first: {
        outcome: 'refused',
        tool: 'github__create_branch',
        refusal_code: 'risk-not-accepted',
      },
    });
  });

  it('reads an allowed first call, and nothing in an answer that is not one', () => {
    expect(
      seenOf({ called_at: 'x', first: { outcome: 'allowed', tool: 't', refusal_code: null } }),
    ).toEqual({ state: 'called', first: { outcome: 'allowed', tool: 't', refusal_code: null } });
    expect(seenOf('nope')).toBeNull();
  });
});
