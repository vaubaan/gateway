/**
 * Credential separation (spec §6, §10): a mission token on the management
 * door, a delegated token on the execution door, a session on either, are
 * refused unambiguously with `wrong-credential-kind`.
 */
import { describe, expect, test } from 'vitest';

import {
  AuthError,
  DoorAuthenticator,
  EXPECTED_CREDENTIAL_BY_DOOR,
  checkDoor,
  isRefusal,
  parseBearer,
  type CredentialResolver,
  type MissionContext,
  type ResolvedCredential,
} from '../../src/index.ts';

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
  connections: [],
  resources: [],
  policy: [],
  session: null,
};

const KNOWN: Record<string, ResolvedCredential> = {
  'mission-secret': { kind: 'mission-token', context: missionCtx },
  'delegated-secret': {
    kind: 'delegated-token',
    delegation: {
      delegation_id: 'del_1',
      user_id: 'usr_1',
      client_id: 'cli_1',
      scopes: ['mgmt:missions'],
      expires_at: '2026-10-13T11:00:00.000Z',
    },
  },
  'session-secret': { kind: 'human-session', user_id: 'usr_1' },
};

const resolver: CredentialResolver = {
  resolve: async (bearer) => KNOWN[bearer] ?? null,
};

describe('checkDoor', () => {
  test('each door expects exactly one bearer kind', () => {
    expect(EXPECTED_CREDENTIAL_BY_DOOR).toEqual({
      execution: 'mission-token',
      management: 'delegated-token',
    });
  });

  test('matching kind passes', () => {
    expect(checkDoor('mission-token', 'execution')).toBeNull();
    expect(checkDoor('delegated-token', 'management')).toBeNull();
  });

  test('every other combination is a wrong-credential-kind refusal naming door, presented, expected', () => {
    const cases = [
      ['mission-token', 'management', 'delegated-token'],
      ['delegated-token', 'execution', 'mission-token'],
      ['human-session', 'execution', 'mission-token'],
      ['human-session', 'management', 'delegated-token'],
    ] as const;
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

  test('mission token at the management door is refused as wrong-credential-kind', async () => {
    const out = await auth.authenticate('Bearer mission-secret', 'management');
    expect(isRefusal(out)).toBe(true);
    if (!isRefusal(out) || out.code !== 'wrong-credential-kind') throw new Error('wrong code');
    expect(out.presented).toBe('mission-token');
    expect(out.expected).toBe('delegated-token');
  });

  test('delegated token at the execution door is refused as wrong-credential-kind', async () => {
    const out = await auth.authenticateMission('Bearer delegated-secret');
    expect(isRefusal(out)).toBe(true);
    if (!isRefusal(out) || out.code !== 'wrong-credential-kind') throw new Error('wrong code');
    expect(out.door).toBe('execution');
    expect(out.presented).toBe('delegated-token');
    expect(out.expected).toBe('mission-token');
  });

  test('delegated token at the management door passes', async () => {
    const out = await auth.authenticate('Bearer delegated-secret', 'management');
    expect(isRefusal(out)).toBe(false);
    if (isRefusal(out)) throw new Error('unexpected refusal');
    expect(out.kind).toBe('delegated-token');
  });

  test('a human session opens neither door', async () => {
    const a = await auth.authenticate('Bearer session-secret', 'execution');
    const b = await auth.authenticate('Bearer session-secret', 'management');
    expect(isRefusal(a) && a.code === 'wrong-credential-kind').toBe(true);
    expect(isRefusal(b) && b.code === 'wrong-credential-kind').toBe(true);
  });

  test('unknown bearer is an AuthError (nothing identified, so no refusal)', async () => {
    await expect(auth.authenticate('Bearer nope', 'execution')).rejects.toThrow(AuthError);
    await expect(auth.authenticateMission(null)).rejects.toThrow(AuthError);
  });
});
