import { describe, expect, it } from 'vitest';

import { messageOf, statedMessageOf } from './message-of';

describe('messageOf', () => {
  it('reads the message of a JSON refusal', () => {
    const body = { error: 'mission-inactive', message: 'This mission is revoked.' };
    expect(statedMessageOf(body)).toBe('This mission is revoked.');
    expect(messageOf(body, 409)).toBe('This mission is revoked.');
  });

  it('falls back to the status when the body states nothing usable', () => {
    for (const body of [null, undefined, 'text', 42, {}, { message: 7 }, { message: null }]) {
      expect(statedMessageOf(body)).toBeNull();
      expect(messageOf(body, 502)).toBe('The instance answered 502.');
    }
  });
});
