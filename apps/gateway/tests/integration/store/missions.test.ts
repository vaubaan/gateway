/**
 * Missions: connections with resource selection, policy rows checked against the catalog,
 * tokens — one holder each, rotated or revoked on its own — and members. Spec §0
 * "Mission member", "Mission token"; §2.2, §3.2.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvariantError,
  TokenNotIssuableError,
  UnknownRiskIdError,
  type MissionPolicyLineInput,
  type Store,
  type TokenHolderRecord,
} from '../../../src/server/store/index.ts';
import {
  firstSetOf,
  flatConnections,
  flatPolicy,
  openTestStore,
  type TestStore,
} from '../../support/store/testing.ts';

const POLICY: MissionPolicyLineInput[] = [
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
    creator = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'c',
        email: 'c@x',
      })
    ).id;
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
      connections: [{ connectionId: connection, resourceIds: [] }],
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
    expect(flatConnections(m)).toEqual([{ connectionId: connection, resourceIds: [] }]);
    expect(flatPolicy(m)).toEqual(POLICY);
    expect(
      store.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM mission_policy WHERE mission_id = ?',
        )
        .get(m.id)?.n,
    ).toBe(2);
    expect(await store.missions.getById(m.id)).toEqual(m);
    expect((await store.missions.listForCreator(creator)).map((x) => x.id)).toEqual([m.id]);
    expect((await store.missions.listForConnection(connection)).map((x) => x.id)).toEqual([m.id]);
  });

  it('records a resource selection per connection', async () => {
    const m = await create({
      connections: [
        { connectionId: connection, resourceIds: [resourceA] },
        { connectionId: otherConnection, resourceIds: [] },
      ],
    });
    const byId = (a: { connectionId: string }, b: { connectionId: string }) =>
      a.connectionId.localeCompare(b.connectionId);
    expect([...flatConnections(m)].sort(byId)).toEqual(
      [
        { connectionId: connection, resourceIds: [resourceA] },
        { connectionId: otherConnection, resourceIds: [] },
      ].sort(byId),
    );
  });

  it('stores a set with future on and its environment, an explicit list like any other', async () => {
    const m = await create({
      connections: [{ connectionId: connection, resourceIds: [resourceA], future: true }],
    });
    expect(flatConnections(m)).toEqual([
      { connectionId: connection, resourceIds: [resourceA], future: true },
    ]);
    expect(
      store.db
        .prepare('SELECT COUNT(*) AS n FROM mission_resources WHERE mission_id = ?')
        .get(m.id),
    ).toEqual({ n: 1 });
    expect((await store.missions.getById(m.id))?.connections).toEqual(m.connections);
    // A set of future resources only names its environment.
    const empty = await create({
      connections: [{ connectionId: connection, resourceIds: [], future: true, env: 'prod' }],
    });
    expect(flatConnections(empty)).toEqual([
      { connectionId: connection, resourceIds: [], future: true, env: 'prod' },
    ]);
  });

  it('rejects inconsistent resource selections', async () => {
    await expect(
      create({
        connections: [{ connectionId: connection, resourceIds: [resourceA], env: 'prod' }],
      }),
    ).rejects.toThrow(/several environments/);
    await expect(
      create({
        connections: [
          {
            connectionId: connection,
            resourceSets: [
              { resourceIds: [resourceA], future: true, policy: [] },
              { resourceIds: [], future: true, policy: [] },
            ],
          },
        ],
        policy: [],
      }),
    ).rejects.toThrow(/two resource sets take the future resources of one environment/);
    await expect(
      create({
        connections: [{ connectionId: otherConnection, resourceIds: [resourceA] }],
        policy: [],
      }),
    ).rejects.toThrow(/does not belong/);
    await expect(create({ connections: [], policy: [] })).rejects.toThrow(
      /at least one connection/,
    );
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
    const updated = await store.missions.replacePolicy(m.id, [
      { ...POLICY[0]!, resourceSetId: firstSetOf(m) },
    ]);
    expect(flatPolicy(updated)).toEqual([POLICY[0]]);
    await expect(
      store.missions.replacePolicy(m.id, [
        { ...POLICY[0]!, riskId: 'nope', resourceSetId: firstSetOf(m) },
      ]),
    ).rejects.toThrow(UnknownRiskIdError);
    expect(flatPolicy((await store.missions.getById(m.id))!)).toEqual([POLICY[0]]);
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

  // ── Tokens: one holder each ────────────────────────────────────────────────

  const member = (userId: string) => ({ kind: 'member', userId }) as const;
  const named = (name: string) => ({ kind: 'named', name }) as const;

  function issue(missionId: string, prefix: string, holder: TokenHolderRecord) {
    return store.missions.issueToken({
      missionId,
      prefix,
      hash: `hash-of-${prefix}`,
      hashAlg: 'argon2id',
      holder,
      createdBy: creator,
    });
  }

  it('issues one active token per member; a member rotating retires their own token only', async () => {
    const m = await create();
    const bob = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'b',
        email: 'b@x',
      })
    ).id;
    await store.missions.addMember({ missionId: m.id, userId: bob, addedBy: creator });

    const first = await issue(m.id, 'vbn_live_aaaa', member(creator));
    expect(first.token).toMatchObject({
      status: 'active',
      kind: 'member',
      holder: { kind: 'member', userId: creator },
      createdBy: creator,
      lastUsedAt: null,
    });
    expect(first.replaced).toBeNull();
    const found = await store.missions.findTokenByPrefix('vbn_live_aaaa');
    expect(found?.token.id).toBe(first.token.id);
    expect(found?.mission.id).toBe(m.id);
    const bobs = await issue(m.id, 'vbn_live_bob1', member(bob));
    const ci = await issue(m.id, 'vbn_live_ci01', named('CI runner'));

    t.clock.advance(1000);
    const second = await issue(m.id, 'vbn_live_bbbb', member(creator));
    expect(second.replaced?.id).toBe(first.token.id);
    const tokens = await store.missions.listTokens(m.id);
    expect(tokens.map((x) => [x.prefix, x.status])).toEqual([
      ['vbn_live_aaaa', 'rotated'],
      ['vbn_live_bob1', 'active'],
      ['vbn_live_ci01', 'active'],
      ['vbn_live_bbbb', 'active'],
    ]);
    expect(tokens[0]?.retiredAt).toBe(t.clock.now().toISOString());
    expect(
      await store.missions.getToken({ missionId: m.id, tokenId: bobs.token.id }),
    ).toMatchObject({ status: 'active' });
    expect(await store.missions.getToken({ missionId: m.id, tokenId: ci.token.id })).toMatchObject({
      status: 'active',
      kind: 'named',
      holder: { kind: 'named', name: 'CI runner' },
    });

    expect(await store.missions.revokeTokens(m.id)).toBe(3);
    expect((await store.missions.findTokenByPrefix('vbn_live_bbbb'))?.token.status).toBe('revoked');
    expect(await store.missions.findTokenByPrefix('unknown')).toBeNull();
    expect(await store.missions.getToken({ missionId: m.id, tokenId: 'unknown' })).toBeNull();
  });

  it('revokes one token on its own; the others keep working', async () => {
    const m = await create();
    const mine = await issue(m.id, 'p-mine', member(creator));
    const ci = await issue(m.id, 'p-ci', named('CI runner'));
    t.clock.advance(1000);
    const revoked = await store.missions.revokeToken({ missionId: m.id, tokenId: ci.token.id });
    expect(revoked).toMatchObject({ status: 'revoked', retiredAt: t.clock.now().toISOString() });
    // Idempotent: nothing is written the second time.
    expect(await store.missions.revokeToken({ missionId: m.id, tokenId: ci.token.id })).toBeNull();
    expect(await store.missions.revokeToken({ missionId: m.id, tokenId: 'unknown' })).toBeNull();
    // A token named with another mission is not there: read as missing, nothing written.
    const other = await create();
    expect(
      await store.missions.getToken({ missionId: other.id, tokenId: mine.token.id }),
    ).toBeNull();
    expect(
      await store.missions.revokeToken({ missionId: other.id, tokenId: mine.token.id }),
    ).toBeNull();
    expect(
      await store.missions.markTokenUsed({ missionId: other.id, tokenId: mine.token.id }, 60),
    ).toBe(false);
    expect(
      (await store.missions.getToken({ missionId: m.id, tokenId: mine.token.id }))?.status,
    ).toBe('active');
    // The name is free again once its token is retired.
    await expect(issue(m.id, 'p-ci-2', named('CI runner'))).resolves.toMatchObject({
      replaced: null,
    });
  });

  it('a name identifies one active named token: a second one is refused, and nothing is retired', async () => {
    const m = await create();
    await issue(m.id, 'p-ci', named('CI runner'));
    await expect(issue(m.id, 'p-ci-2', named('CI runner'))).rejects.toBeInstanceOf(
      TokenNotIssuableError,
    );
    expect((await store.missions.findTokenByPrefix('p-ci'))?.token.status).toBe('active');
    expect(await store.missions.findTokenByPrefix('p-ci-2')).toBeNull();
    // Another mission may use the same name.
    const other = await create({ name: 'Other' });
    await expect(issue(other.id, 'p-ci-3', named('CI runner'))).resolves.toBeDefined();
  });

  it('the schema enforces one active token per holder, the holder of each kind, and unique prefixes', async () => {
    const m = await create();
    await issue(m.id, 'p1', member(creator));
    const insert = (
      id: string,
      prefix: string,
      kind: string,
      holder: string | null,
      name: string | null,
    ) =>
      store.db
        .prepare(
          `INSERT INTO mission_tokens (id, mission_id, prefix, hash, hash_alg, status, kind,
             holder_user_id, name, created_by, created_at)
           VALUES (?, ?, ?, 'h', 'sha256', 'active', ?, ?, ?, ?, '2026-10-13T00:00:00.000Z')`,
        )
        .run(id, m.id, prefix, kind, holder, name, creator);
    // A second active token of the same member.
    expect(() => insert('t2', 'p2', 'member', creator, null)).toThrow(/UNIQUE/);
    // A member token names a user and no name; a named token a name and no user.
    expect(() => insert('t3', 'p3', 'member', null, null)).toThrow(/CHECK/);
    expect(() => insert('t4', 'p4', 'member', creator, 'CI')).toThrow(/CHECK/);
    expect(() => insert('t5', 'p5', 'named', null, null)).toThrow(/CHECK/);
    expect(() => insert('t6', 'p6', 'named', null, '')).toThrow(/CHECK/);
    expect(() => insert('t7', 'p7', 'named', creator, 'CI')).toThrow(/CHECK/);
    expect(() => insert('t8', 'p8', 'machine', null, 'CI')).toThrow(/CHECK/);
    // A prefix is unique across every mission and status.
    await expect(issue(m.id, 'p1', named('CI'))).rejects.toThrow(/UNIQUE/);
    expect((await store.missions.findTokenByPrefix('p1'))?.token.status).toBe('active');
  });

  it('stores a hash, never a secret: no column of a token row can give the bearer back', async () => {
    const m = await create();
    await issue(m.id, 'p1', member(creator));
    const columns = store.db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('mission_tokens')")
      .all()
      .map((c) => c.name)
      .sort();
    expect(columns).toEqual([
      'created_at',
      'created_by',
      'hash',
      'hash_alg',
      'holder_user_id',
      'id',
      'kind',
      'last_used_at',
      'mission_id',
      'name',
      'prefix',
      'retired_at',
      'status',
    ]);
  });

  it('records the last use of a token at most once per granularity', async () => {
    const m = await create();
    const { token } = await issue(m.id, 'p1', member(creator));
    expect(await store.missions.markTokenUsed({ missionId: m.id, tokenId: token.id }, 60)).toBe(
      true,
    );
    const first = t.clock.now().toISOString();
    expect(
      (await store.missions.getToken({ missionId: m.id, tokenId: token.id }))?.lastUsedAt,
    ).toBe(first);
    t.clock.advance(30_000);
    expect(await store.missions.markTokenUsed({ missionId: m.id, tokenId: token.id }, 60)).toBe(
      false,
    );
    expect(
      (await store.missions.getToken({ missionId: m.id, tokenId: token.id }))?.lastUsedAt,
    ).toBe(first);
    t.clock.advance(31_000);
    expect(await store.missions.markTokenUsed({ missionId: m.id, tokenId: token.id }, 60)).toBe(
      true,
    );
    expect(
      (await store.missions.getToken({ missionId: m.id, tokenId: token.id }))?.lastUsedAt,
    ).toBe(t.clock.now().toISOString());
    expect(await store.missions.markTokenUsed({ missionId: m.id, tokenId: 'unknown' }, 60)).toBe(
      false,
    );
  });

  // ── Members ────────────────────────────────────────────────────────────────

  it('adds, lists and removes members; the creator is never a row', async () => {
    const m = await create();
    const bob = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'b',
        email: 'b@x',
      })
    ).id;
    const carol = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'k',
        email: 'k@x',
      })
    ).id;
    expect(await store.missions.listMembers(m.id)).toEqual([]);
    await expect(
      store.missions.addMember({ missionId: m.id, userId: creator, addedBy: creator }),
    ).rejects.toBeInstanceOf(InvariantError);

    const added = await store.missions.addMember({
      missionId: m.id,
      userId: bob,
      addedBy: creator,
    });
    expect(added).toEqual({
      member: {
        missionId: m.id,
        userId: bob,
        addedBy: creator,
        addedAt: t.clock.now().toISOString(),
        removedAt: null,
      },
      // A member starts with no token, and there was none to revoke.
      tokenRevoked: null,
    });
    t.clock.advance(1000);
    await store.missions.addMember({ missionId: m.id, userId: carol, addedBy: creator });
    expect((await store.missions.listMembers(m.id)).map((x) => x.userId)).toEqual([bob, carol]);
    expect((await store.missions.listForMember(bob)).map((x) => x.id)).toEqual([m.id]);
    // What the creator created is not "shared with them".
    expect(await store.missions.listForMember(creator)).toEqual([]);
    expect(await store.missions.getMember(m.id, 'nobody')).toBeNull();
  });

  it('removing a member revokes their token in the same step, and only theirs', async () => {
    const m = await create();
    const bob = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'b',
        email: 'b@x',
      })
    ).id;
    await store.missions.addMember({ missionId: m.id, userId: bob, addedBy: creator });
    const mine = await issue(m.id, 'p-mine', member(creator));
    const bobs = await issue(m.id, 'p-bob', member(bob));

    t.clock.advance(1000);
    const removed = await store.missions.removeMember(m.id, bob);
    expect(removed?.member.removedAt).toBe(t.clock.now().toISOString());
    expect(removed?.tokenRevoked?.id).toBe(bobs.token.id);
    expect(
      (await store.missions.getToken({ missionId: m.id, tokenId: bobs.token.id }))?.status,
    ).toBe('revoked');
    expect(
      (await store.missions.getToken({ missionId: m.id, tokenId: mine.token.id }))?.status,
    ).toBe('active');
    expect(await store.missions.listMembers(m.id)).toEqual([]);
    expect(await store.missions.listForMember(bob)).toEqual([]);
    expect((await store.missions.getMember(m.id, bob))?.removedAt).not.toBeNull();
    // Not a member any more: nothing to remove.
    expect(await store.missions.removeMember(m.id, bob)).toBeNull();
    expect(await store.missions.removeMember(m.id, creator)).toBeNull();

    // Added again: a member, with no token (the old one stays revoked).
    t.clock.advance(1000);
    const again = await store.missions.addMember({
      missionId: m.id,
      userId: bob,
      addedBy: creator,
    });
    expect(again.member).toMatchObject({ removedAt: null, addedAt: t.clock.now().toISOString() });
    expect(again.tokenRevoked).toBeNull();
    expect(
      (await store.missions.getToken({ missionId: m.id, tokenId: bobs.token.id }))?.status,
    ).toBe('revoked');
    const removedAgain = await store.missions.removeMember(m.id, bob);
    expect(removedAgain?.tokenRevoked).toBeNull();
  });

  it('a token is inserted only for a mission that serves and a holder who is on it, checked in the insert', async () => {
    const m = await create();
    const user = async (subject: string): Promise<string> =>
      (
        await store.users.upsertFromIdp({
          issuer: 'http://idp.test',
          subject,
          email: `${subject}@x`,
        })
      ).id;
    const bob = await user('bob');
    const refusal = async (run: Promise<unknown>): Promise<string> => {
      try {
        await run;
      } catch (err) {
        if (err instanceof TokenNotIssuableError) return err.reason;
        throw err;
      }
      return 'issued';
    };
    const tokensOf = async (): Promise<number> => (await store.missions.listTokens(m.id)).length;

    // Never added.
    expect(await refusal(issue(m.id, 'p-1', member(bob)))).toBe('holder-not-a-member');
    // Added, then removed.
    await store.missions.addMember({ missionId: m.id, userId: bob, addedBy: creator });
    await store.missions.removeMember(m.id, bob);
    expect(await refusal(issue(m.id, 'p-2', member(bob)))).toBe('holder-not-a-member');
    // A member again, then deactivated by an operator.
    await store.missions.addMember({ missionId: m.id, userId: bob, addedBy: creator });
    await store.users.markRemoved(bob);
    expect(await refusal(issue(m.id, 'p-3', member(bob)))).toBe('holder-not-a-member');
    // A user the instance does not know.
    expect(await refusal(issue(m.id, 'p-4', member('ghost')))).toBe('holder-not-a-member');
    expect(await tokensOf()).toBe(0);

    // Reactivated and still a member: issued. The creator needs no row.
    await store.users.reactivate(bob);
    expect(await refusal(issue(m.id, 'p-5', member(bob)))).toBe('issued');
    expect(await refusal(issue(m.id, 'p-6', member(creator)))).toBe('issued');
    // A name a working token carries.
    expect(await refusal(issue(m.id, 'p-7', { kind: 'named', name: 'ci' }))).toBe('issued');
    expect(await refusal(issue(m.id, 'p-8', { kind: 'named', name: 'ci' }))).toBe('name-taken');

    // The mission no longer serves: nobody gets a token, the creator included.
    await store.missions.setStatus(m.id, 'revoked');
    for (const holder of [
      member(bob),
      member(creator),
      { kind: 'named', name: 'other' } as const,
    ]) {
      expect(await refusal(issue(m.id, 'p-9', holder))).toBe('mission-not-active');
    }
    expect(await tokensOf()).toBe(3);
  });

  it('adding a member revokes a working token of theirs that predates the membership', async () => {
    const m = await create();
    const bob = (
      await store.users.upsertFromIdp({ issuer: 'http://idp.test', subject: 'b', email: 'b@x' })
    ).id;
    // A row no current path writes: a working member token of somebody who is not a member.
    store.db
      .prepare(
        `INSERT INTO mission_tokens (id, mission_id, prefix, hash, hash_alg, status, kind,
           holder_user_id, name, created_by, created_at)
         VALUES ('stale', ?, 'p-stale', 'h', 'argon2id', 'active', 'member', ?, NULL, ?, ?)`,
      )
      .run(m.id, bob, bob, t.clock.now().toISOString());

    const added = await store.missions.addMember({
      missionId: m.id,
      userId: bob,
      addedBy: creator,
    });

    expect(added.tokenRevoked).toMatchObject({ id: 'stale', status: 'revoked' });
    expect((await store.missions.getToken({ missionId: m.id, tokenId: 'stale' }))?.status).toBe(
      'revoked',
    );
  });

  it('revokes the member tokens of a user on the missions they did not create, and leaves their own missions alone', async () => {
    const bob = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'b',
        email: 'b@x',
      })
    ).id;
    const shared = await create({ name: 'Shared with Bob' });
    const other = await create({ name: 'Also shared' });
    const bobsOwn = await create({ name: 'Bob created this', creatorUserId: bob });
    for (const mission of [shared, other]) {
      await store.missions.addMember({ missionId: mission.id, userId: bob, addedBy: creator });
    }
    const a = await issue(shared.id, 'p-a', member(bob));
    const b = await issue(other.id, 'p-b', member(bob));
    const own = await issue(bobsOwn.id, 'p-own', member(bob));
    const creators = await issue(shared.id, 'p-creator', member(creator));

    const revoked = await store.missions.revokeMemberTokensOf(bob);
    expect(revoked.map((x) => x.id).sort()).toEqual([a.token.id, b.token.id].sort());
    expect(revoked.every((x) => x.status === 'revoked')).toBe(true);
    // Their own mission follows the derived `orphaned` rule instead: the token is kept.
    expect(
      (await store.missions.getToken({ missionId: bobsOwn.id, tokenId: own.token.id }))?.status,
    ).toBe('active');
    expect(
      (await store.missions.getToken({ missionId: shared.id, tokenId: creators.token.id }))?.status,
    ).toBe('active');
    // Still a member: a reactivated user generates a new token.
    expect((await store.missions.listMembers(shared.id)).map((x) => x.userId)).toEqual([bob]);
    expect(await store.missions.revokeMemberTokensOf(bob)).toEqual([]);
  });
  it('setLimits moves the quota and the rate of listed risks, in one transaction, and nothing else', async () => {
    const m = await create();
    const session = await store.sessions.getOrCreate(m.id);
    const result = await store.missions.setLimits(
      m.id,
      [
        { riskId: 'github.code-read', quota: 7, rateLimit: 30 },
        { riskId: 'github.merge-protected', quota: 2, rateLimit: 1 },
      ],
      creator,
    );
    expect(result?.changes).toEqual([
      {
        resourceSetId: firstSetOf(m),
        riskId: 'github.code-read',
        before: { quota: 100, rateLimit: 30 },
        after: { quota: 7, rateLimit: 30 },
        rateWindowSeconds: 60,
        changed: true,
      },
      {
        resourceSetId: firstSetOf(m),
        riskId: 'github.merge-protected',
        before: { quota: 2, rateLimit: 1 },
        after: { quota: 2, rateLimit: 1 },
        rateWindowSeconds: 600,
        changed: false,
      },
    ]);
    expect(flatPolicy(result!.mission)).toEqual([{ ...POLICY[0], quota: 7 }, POLICY[1]]);
    // One event, for the risk that moved.
    expect(await store.sessions.listEvents(session.id)).toMatchObject([
      {
        kind: 'limits-changed',
        riskId: 'github.code-read',
        actorUserId: creator,
        details: { quota: 7, quota_before: 100, rate_limit_max: 30, rate_limit_max_before: 30 },
      },
    ]);
  });

  it('setLimits writes nothing when one listed risk is not in the policy, and refuses a negative or repeated line', async () => {
    const m = await create();
    expect(
      await store.missions.setLimits(
        m.id,
        [
          { riskId: 'github.code-read', quota: 1, rateLimit: 1 },
          { riskId: 'github.bulk-file-write', quota: 1, rateLimit: 1 },
        ],
        creator,
      ),
    ).toBeNull();
    expect(flatPolicy((await store.missions.getById(m.id))!)).toEqual(POLICY);
    await expect(
      store.missions.setLimits(
        m.id,
        [{ riskId: 'github.code-read', quota: -1, rateLimit: 1 }],
        creator,
      ),
    ).rejects.toThrow(InvariantError);
    await expect(
      store.missions.setLimits(
        m.id,
        [
          { riskId: 'github.code-read', quota: 1, rateLimit: 1 },
          { riskId: 'github.code-read', quota: 2, rateLimit: 1 },
        ],
        creator,
      ),
    ).rejects.toThrow(InvariantError);
  });

  it('the decision reads the stored limits of the touched risks inside its transaction', async () => {
    const m = await create();
    await store.missions.setLimits(
      m.id,
      [{ riskId: 'github.code-read', quota: 3, rateLimit: 4 }],
      creator,
    );
    const seen = await store.sessions.decideAndDecrement(
      { missionId: m.id, riskIds: ['github.code-read'], periodStart: m.periodAnchor },
      (ctx) => ({ allow: false, limits: ctx.limits }),
    );
    expect([...seen.outcome.limits]).toEqual([
      [
        `${firstSetOf(m)}::github.code-read`,
        { quota: 3, rateLimit: 4, rateWindowSeconds: 60, gate: 'auto' },
      ],
    ]);
  });

  describe('edit (ADR mission-editable-after-issuance)', () => {
    const summary = (closed: number) =>
      ({
        kind: 'mission-changed',
        details: {
          name_changed: true,
          expiry_changed: false,
          connections_added: 1,
          connections_removed: 0,
          resources_added: 1,
          resources_removed: 0,
          scopes_changed: 1,
          permissions_added: ['supabase[staging].bulk-row-write'],
          permissions_removed: ['github.merge-protected'],
          limits: [],
          gates: [],
          requests_closed: closed,
        },
      }) as const;

    it('makes the mission the edited state in one transaction, with an event per risk that moved', async () => {
      const m = await create();
      // A session, so the events have somewhere to go.
      await store.sessions.decideAndDecrement(
        { missionId: m.id, riskIds: ['github.code-read'], periodStart: m.periodAnchor },
        () => ({ allow: true }),
      );
      const result = await store.missions.edit(m.id, {
        actorUserId: creator,
        unchanged: () => true,
        name: 'Ship feature Y',
        expiresAt: null,
        connections: [
          { connectionId: connection, resourceIds: [resourceA] },
          { connectionId: otherConnection, resourceIds: [], future: true, env: 'staging' },
        ],
        policy: [
          {
            riskId: 'github.code-read',
            quota: 50,
            rateLimit: 30,
            rateWindowSeconds: 120,
            gate: 'approval',
          },
          {
            riskId: 'supabase[staging].bulk-row-write',
            quota: 5,
            rateLimit: 5,
            rateWindowSeconds: 60,
            gate: 'auto',
          },
        ],
        summary,
      });
      expect(result?.before.name).toBe('Ship feature X');
      expect(result?.mission).toMatchObject({ name: 'Ship feature Y' });
      expect(flatConnections(result!.mission)).toMatchObject([
        { connectionId: connection, resourceIds: [resourceA] },
        { connectionId: otherConnection, resourceIds: [], future: true, env: 'staging' },
      ]);
      // The kept connection kept its one set: its counters follow it.
      expect(firstSetOf(result!.mission, connection)).toBe(firstSetOf(m, connection));
      expect(result?.mission.policy.map((p) => p.riskId).sort()).toEqual([
        'github.code-read',
        'supabase[staging].bulk-row-write',
      ]);
      const session = await store.sessions.getByMission(m.id);
      const events = session ? await store.sessions.listEvents(session.id) : [];
      expect(events.map((e) => [e.kind, e.riskId])).toEqual(
        expect.arrayContaining([
          ['permission-removed', 'github.merge-protected'],
          ['permission-added', 'supabase[staging].bulk-row-write'],
          ['limits-changed', 'github.code-read'],
          ['gate-changed', 'github.code-read'],
          ['mission-changed', null],
        ]),
      );
      const limits = events.find((e) => e.kind === 'limits-changed');
      expect(limits?.details).toMatchObject({
        quota: 50,
        quota_before: 100,
        rate_window_seconds: 120,
        rate_window_seconds_before: 60,
      });
    });

    it('writes nothing when the state it was judged against moved, or for anyone but the creator', async () => {
      const m = await create();
      const input = {
        actorUserId: creator,
        unchanged: () => false,
        name: 'Never',
        expiresAt: null,
        connections: flatConnections(m),
        policy: flatPolicy(m),
        summary,
      };
      expect(await store.missions.edit(m.id, input)).toBeNull();
      expect(
        await store.missions.edit(m.id, {
          ...input,
          unchanged: () => true,
          actorUserId: 'someone-else',
        }),
      ).toBeNull();
      expect((await store.missions.getById(m.id))?.name).toBe('Ship feature X');
      await store.missions.setStatus(m.id, 'revoked');
      expect(await store.missions.edit(m.id, { ...input, unchanged: () => true })).toBeNull();
    });

    it('refuses a policy the catalog does not know before it opens the transaction', async () => {
      const m = await create();
      await expect(
        store.missions.edit(m.id, {
          actorUserId: creator,
          unchanged: () => true,
          name: m.name,
          expiresAt: null,
          connections: flatConnections(m),
          policy: [
            { riskId: 'github.nope', quota: 1, rateLimit: 1, rateWindowSeconds: 60, gate: 'auto' },
          ],
          summary,
        }),
      ).rejects.toThrow(UnknownRiskIdError);
    });
  });
});
