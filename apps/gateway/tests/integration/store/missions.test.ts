/**
 * Missions: connections with resource selection, policy rows checked against the catalog,
 * token issuance and rotation (one active token per mission). Spec §2.2, §3.2.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvariantError,
  UnknownRiskIdError,
  type MissionPolicyEntry,
  type Store,
} from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

const POLICY: MissionPolicyEntry[] = [
  { riskId: 'github.code-read', quota: 100, rateLimit: 30, rateWindowSeconds: 60, gate: 'auto' },
  {
    riskId: 'github.merge-protected',
    quota: 2,
    rateLimit: 1,
    rateWindowSeconds: 600,
    gate: 'approval',
  },
];

describe('missions repository', () => {
  let t: TestStore;
  let store: Store;
  let creator: string;
  let connection: string;
  let resourceA: string;
  let otherConnection: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    creator = (await store.users.upsertFromIdp({ subject: 'c', email: 'c@x' })).id;
    connection = (
      await store.connections.create({
        provider: 'github',
        owner: { kind: 'user', id: creator },
        displayName: 'gh',
        credential: null,
      })
    ).id;
    const resources = await store.connections.syncDiscoveredResources(connection, [
      { ref: 'acme/a', displayName: 'A' },
      { ref: 'acme/b', displayName: 'B' },
    ]);
    resourceA = resources[0]?.id ?? '';
    otherConnection = (
      await store.connections.create({
        provider: 'supabase',
        owner: { kind: 'user', id: creator },
        displayName: 'sb',
        credential: null,
      })
    ).id;
  });
  afterEach(() => store.close());

  function create(overrides: Partial<Parameters<Store['missions']['create']>[0]> = {}) {
    return store.missions.create({
      name: 'Ship feature X',
      creatorUserId: creator,
      periodSeconds: 7 * 86_400,
      connections: [{ connectionId: connection, resourceScope: 'all', resourceIds: [] }],
      policy: POLICY,
      ...overrides,
    });
  }

  it('creates a mission with its connections and policy rows', async () => {
    const m = await create({ expiresAt: '2026-12-31T00:00:00.000Z' });
    expect(m).toMatchObject({
      name: 'Ship feature X',
      creatorUserId: creator,
      status: 'active',
      periodAnchor: '2026-10-13T09:00:00.000Z',
      periodSeconds: 604_800,
      expiresAt: '2026-12-31T00:00:00.000Z',
      delegationId: null,
    });
    expect(m.connections).toEqual([
      { connectionId: connection, resourceScope: 'all', resourceIds: [] },
    ]);
    expect(m.policy).toEqual(POLICY);
    expect(
      store.db
        .prepare<
          [string],
          { n: number }
        >('SELECT COUNT(*) AS n FROM mission_policy WHERE mission_id = ?')
        .get(m.id)?.n,
    ).toBe(2);
    expect(await store.missions.getById(m.id)).toEqual(m);
    expect((await store.missions.listForCreator(creator)).map((x) => x.id)).toEqual([m.id]);
    expect((await store.missions.listForConnection(connection)).map((x) => x.id)).toEqual([m.id]);
  });

  it('records a resource selection per connection', async () => {
    const m = await create({
      connections: [
        { connectionId: connection, resourceScope: 'selected', resourceIds: [resourceA] },
        { connectionId: otherConnection, resourceScope: 'all', resourceIds: [] },
      ],
    });
    const byId = (a: { connectionId: string }, b: { connectionId: string }) =>
      a.connectionId.localeCompare(b.connectionId);
    expect([...m.connections].sort(byId)).toEqual(
      [
        { connectionId: connection, resourceScope: 'selected', resourceIds: [resourceA] },
        { connectionId: otherConnection, resourceScope: 'all', resourceIds: [] },
      ].sort(byId),
    );
  });

  it('rejects inconsistent resource selections', async () => {
    await expect(
      create({
        connections: [{ connectionId: connection, resourceScope: 'selected', resourceIds: [] }],
      }),
    ).rejects.toThrow(InvariantError);
    await expect(
      create({
        connections: [{ connectionId: connection, resourceScope: 'all', resourceIds: [resourceA] }],
      }),
    ).rejects.toThrow(InvariantError);
    await expect(
      create({
        connections: [
          { connectionId: otherConnection, resourceScope: 'selected', resourceIds: [resourceA] },
        ],
      }),
    ).rejects.toThrow(/does not belong/);
    await expect(create({ connections: [] })).rejects.toThrow(/at least one connection/);
    expect(await store.missions.listForCreator(creator)).toEqual([]);
  });

  it('refuses a policy whose risk is not in the catalog, or without a numeric budget', async () => {
    await expect(create({ policy: [{ ...POLICY[0]!, riskId: 'github.*' }] })).rejects.toThrow(
      UnknownRiskIdError,
    );
    await expect(create({ policy: [{ ...POLICY[0]!, quota: -1 }] })).rejects.toThrow(/quota/);
    await expect(create({ policy: [{ ...POLICY[0]!, quota: 1.5 }] })).rejects.toThrow(/quota/);
    await expect(create({ policy: [{ ...POLICY[0]!, rateLimit: -1 }] })).rejects.toThrow(
      /rate limit/,
    );
    await expect(create({ policy: [{ ...POLICY[0]!, rateWindowSeconds: 0 }] })).rejects.toThrow(
      /rate window/,
    );
    await expect(create({ policy: [POLICY[0]!, POLICY[0]!] })).rejects.toThrow(/duplicate/);
    expect(await store.missions.listForCreator(creator)).toEqual([]);
  });

  it('replaces the policy atomically and refuses unknown risks on replacement too', async () => {
    const m = await create();
    const updated = await store.missions.replacePolicy(m.id, [POLICY[0]!]);
    expect(updated.policy).toEqual([POLICY[0]]);
    await expect(
      store.missions.replacePolicy(m.id, [{ ...POLICY[0]!, riskId: 'nope' }]),
    ).rejects.toThrow(UnknownRiskIdError);
    expect((await store.missions.getById(m.id))?.policy).toEqual([POLICY[0]]);
  });

  it('transitions status and expiry', async () => {
    const m = await create();
    const revoked = await store.missions.setStatus(m.id, 'revoked');
    expect(revoked.status).toBe('revoked');
    expect(revoked.closedAt).toBe(t.clock.now().toISOString());
    const extended = await store.missions.setExpiresAt(m.id, '2027-01-01T00:00:00.000Z');
    expect(extended.expiresAt).toBe('2027-01-01T00:00:00.000Z');
    await expect(store.missions.setStatus('missing', 'expired')).rejects.toThrow(/not found/);
  });

  it('issues one active token per mission; rotation retires the previous one', async () => {
    const m = await create();
    const first = await store.missions.issueToken({
      missionId: m.id,
      prefix: 'vbn_live_aaaa',
      hash: 'h1',
      hashAlg: 'argon2id',
    });
    expect(first.status).toBe('active');
    const found = await store.missions.findTokenByPrefix('vbn_live_aaaa');
    expect(found?.token.id).toBe(first.id);
    expect(found?.mission.id).toBe(m.id);

    t.clock.advance(1000);
    const second = await store.missions.issueToken({
      missionId: m.id,
      prefix: 'vbn_live_bbbb',
      hash: 'h2',
      hashAlg: 'argon2id',
    });
    const tokens = await store.missions.listTokens(m.id);
    expect(tokens.map((x) => [x.prefix, x.status])).toEqual([
      ['vbn_live_aaaa', 'rotated'],
      ['vbn_live_bbbb', 'active'],
    ]);
    expect(tokens[0]?.retiredAt).toBe(t.clock.now().toISOString());

    expect(await store.missions.revokeTokens(m.id)).toBe(1);
    expect((await store.missions.findTokenByPrefix('vbn_live_bbbb'))?.token.status).toBe('revoked');
    expect(second.id).not.toBe(first.id);
    expect(await store.missions.findTokenByPrefix('unknown')).toBeNull();
  });

  it('the schema enforces a single active token and unique prefixes', async () => {
    const m = await create();
    await store.missions.issueToken({
      missionId: m.id,
      prefix: 'p1',
      hash: 'h',
      hashAlg: 'sha256',
    });
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO mission_tokens (id, mission_id, prefix, hash, hash_alg, status, created_at)
           VALUES ('t2', ?, 'p2', 'h', 'sha256', 'active', '2026-10-13T00:00:00.000Z')`,
        )
        .run(m.id),
    ).toThrow(/UNIQUE/);
    await expect(
      store.missions.issueToken({ missionId: m.id, prefix: 'p1', hash: 'h', hashAlg: 'sha256' }),
    ).rejects.toThrow(/UNIQUE/);
    // The failed rotation did not retire the active token.
    expect((await store.missions.findTokenByPrefix('p1'))?.token.status).toBe('active');
  });
});
