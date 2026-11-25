/**
 * Credential separation (spec §6, §10): a session presented at the execution
 * door is refused unambiguously with `wrong-credential-kind`.
 */
import { describe, expect, test } from 'vitest';

import { AuthError, isRefusal } from '../../src/errors.ts';
import {
  DoorAuthenticator,
  EXPECTED_CREDENTIAL_BY_DOOR,
  checkDoor,
  parseBearer,
  type CredentialResolver,
  type ResolvedCredential,
} from '../../src/pipeline.ts';
import { type MissionContext } from '../../src/types.ts';

const missionCtx: MissionContext = {
  mission: {
    id: 'mis_1',
    name: 'Ship v2',
    status: 'active',
    creator_id: 'usr_1',
    expires_at: null,
    period: { kind: 'one-off' },
  },
  token: {
    id: 'tok_1',
    prefix: 'vbn_live_abcd1234',
    holder: { kind: 'member', user_id: 'usr_1', display: 'ada@example.com' },
  },
  accounts: [],
  resources: [],
  resource_sets: [],
  policy: [],
  missionLog: null,
};

const KNOWN: Record<string, ResolvedCredential> = {
  'mission-secret': { kind: 'mission-token', context: missionCtx },
  'session-secret': { kind: 'human-session', user_id: 'usr_1' },
};

const resolver: CredentialResolver = {
  resolve: async (bearer) => KNOWN[bearer] ?? null,
};

describe('checkDoor', () => {
  test('the door expects exactly one bearer kind', () => {
    expect(EXPECTED_CREDENTIAL_BY_DOOR).toEqual({ execution: 'mission-token' });
  });

  test('matching kind passes', () => {
    expect(checkDoor('mission-token', 'execution')).toBeNull();
  });

  test('every other combination is a wrong-credential-kind refusal naming door, presented, expected', () => {
    const cases = [['human-session', 'execution', 'mission-token']] as const;
    for (const [presented, door, expected] of cases) {
      const r = checkDoor(presented, door);
      expect(r?.code).toBe('wrong-credential-kind');
      if (r?.code !== 'wrong-credential-kind') throw new Error('wrong code');
      expect(r.door).toBe(door);
      expect(r.presented).toBe(presented);
      expect(r.expected).toBe(expected);
      expect(r.hint).toContain(expected);
    }
  });
});

describe('parseBearer', () => {
  test('strips the scheme, case-insensitively, and trims', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
    expect(parseBearer('bearer   abc  ')).toBe('abc');
  });

  test('missing, malformed or empty header is an AuthError, not a refusal', () => {
    expect(() => parseBearer(null)).toThrow(AuthError);
    expect(() => parseBearer(undefined)).toThrow(AuthError);
    expect(() => parseBearer('Basic abc')).toThrow(AuthError);
    expect(() => parseBearer('Bearer ')).toThrow(AuthError);
  });
});

describe('DoorAuthenticator', () => {
  const auth = new DoorAuthenticator(resolver);

  test('mission token at the execution door yields the mission context', async () => {
    const out = await auth.authenticateMission('Bearer mission-secret');
    expect(isRefusal(out)).toBe(false);
    expect(out).toBe(missionCtx);
  });

  test('a human session does not open the door', async () => {
    const a = await auth.authenticate('Bearer session-secret', 'execution');
    expect(isRefusal(a) && a.code === 'wrong-credential-kind').toBe(true);
  });

  test('unknown bearer is an AuthError (nothing identified, so no refusal)', async () => {
    await expect(auth.authenticate('Bearer nope', 'execution')).rejects.toThrow(AuthError);
    await expect(auth.authenticateMission(null)).rejects.toThrow(AuthError);
  });
});
