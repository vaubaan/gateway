/**
 * A token is never inserted for a holder who stopped being one while its hash was
 * computed (spec §0 "Mission token": "it stops working when the member is removed
 * from the mission or deactivated"; ADR mission-members-and-per-holder-tokens, D5).
 *
 * Generating a token is: check who asks, compute an argon2id hash, insert. The hash
 * takes tens of milliseconds and yields to the event loop, so a removal, a
 * deactivation or a revocation can commit between the check and the insert. The
 * execution door would refuse the token while the holder is out — it reads the
 * membership on every call — but the row would stay `active`, and work again the day
 * the member is added back or the user reactivated, without anyone generating
 * anything. The insert therefore checks again, in its own transaction.
 *
 * Each test puts the competing act inside the minter: it runs exactly in the window.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GatewayRoot } from '../../../src/server/compose/root';
import { silentLogger } from '../../../src/server/logging';
import {
  MissionTeamService,
  mintMissionToken,
  type MissionDraft,
} from '../../../src/server/missions';
import { systemClock } from '../../../src/server/store';
import type { MissionRecord, UserRecord } from '../../../src/server/store/types';
import { buildTestRoot, seedInstance, type SeededInstance } from './support';

describe('missions: a token insert that lost the race is refused', () => {
  let root: GatewayRoot;
  let seeded: SeededInstance;
  let ada: UserRecord;
  let bob: UserRecord;
  let mission: MissionRecord;

  beforeEach(async () => {
    root = await buildTestRoot();
    seeded = await seedInstance(root);
    ({ ada, bob } = seeded);
    const draft: MissionDraft = {
      name: 'Ship the billing page',
      connections: [
        {
          connection_id: seeded.github.connection.id,
          crans: { read: 'confiant', propose: 'confiant' },
        },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    };
    const issued = await root.missions.service.issue(ada, draft);
    if (!issued.ok) throw new Error(`issue refused: ${JSON.stringify(issued)}`);
    mission = issued.mission;
    const added = await root.missions.team.addMember(ada, mission.id, { email: bob.email });
    if (!added.ok) throw new Error(`add refused: ${added.reason}`);
  });
  afterEach(async () => {
    await root.close();
  });

  /** A team service whose minter runs `meanwhile` while "the hash is computed". */
  function teamWhere(meanwhile: () => Promise<unknown>): MissionTeamService {
    return new MissionTeamService({
      store: root.store,
      missions: root.missions.service,
      clock: systemClock,
      logger: silentLogger,
      mint: async () => {
        await meanwhile();
        return mintMissionToken();
      },
    });
  }

  const activeTokensOf = async (userId: string): Promise<number> =>
    (await root.store.missions.listTokens(mission.id)).filter(
      (t) => t.status === 'active' && t.holder.kind === 'member' && t.holder.userId === userId,
    ).length;

  it('removed while the hash was computed: no token, and none appears when the member is added back', async () => {
    const racing = teamWhere(() => root.missions.team.removeMember(ada, mission.id, bob.id));

    const result = await racing.generateToken(bob, mission.id);

    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(await activeTokensOf(bob.id)).toBe(0);
    // Added again: a member with no token. Nothing from before the removal works.
    await root.missions.team.addMember(ada, mission.id, { email: bob.email });
    expect(await activeTokensOf(bob.id)).toBe(0);
    expect((await root.missions.team.team(bob, mission.id))?.my_token).toBeNull();
  });

  it('removed while ROTATING: the old token is revoked by the removal and the new one is not inserted', async () => {
    const first = await root.missions.team.generateToken(bob, mission.id);
    if (!first.ok) throw new Error('expected a first token');
    const racing = teamWhere(() => root.missions.team.removeMember(ada, mission.id, bob.id));

    expect(await racing.generateToken(bob, mission.id)).toEqual({ ok: false, reason: 'not-found' });

    expect(await activeTokensOf(bob.id)).toBe(0);
    expect(await root.missions.service.verifyToken(first.token.secret)).toMatchObject({
      outcome: 'retired',
      reason: 'holder-removed',
    });
    await root.missions.team.addMember(ada, mission.id, { email: bob.email });
    expect(await root.missions.service.verifyToken(first.token.secret)).toMatchObject({
      outcome: 'retired',
      reason: 'revoked',
    });
  });

  it('deactivated while the hash was computed: no token, and none appears on reactivation', async () => {
    const racing = teamWhere(() => root.store.users.markRemoved(bob.id));

    expect(await racing.generateToken(bob, mission.id)).toEqual({ ok: false, reason: 'not-found' });

    expect(await activeTokensOf(bob.id)).toBe(0);
    await root.store.users.reactivate(bob.id);
    expect(await activeTokensOf(bob.id)).toBe(0);
    // Still a member: they generate one, the ordinary way.
    const again = await root.missions.team.generateToken(bob, mission.id);
    expect(again.ok).toBe(true);
  });

  it('the mission revoked while the hash was computed: `inactive`, for a member token and a named one', async () => {
    const racing = teamWhere(() => root.missions.service.revoke(ada, mission.id));

    expect(await racing.generateToken(bob, mission.id)).toEqual({
      ok: false,
      reason: 'inactive',
      state: 'revoked',
    });
    expect(await racing.createNamedToken(ada, mission.id, 'ci runner')).toEqual({
      ok: false,
      reason: 'inactive',
      state: 'revoked',
    });
    const tokens = await root.store.missions.listTokens(mission.id);
    expect(tokens.filter((t) => t.status === 'active')).toEqual([]);
  });

  it('two creations of one name at once: one token, the other is told the name is taken', async () => {
    let raced = false;
    const racing = teamWhere(async () => {
      if (raced) return;
      raced = true;
      const other = await root.missions.team.createNamedToken(ada, mission.id, 'ci runner');
      expect(other.ok).toBe(true);
    });

    expect(await racing.createNamedToken(ada, mission.id, 'ci runner')).toEqual({
      ok: false,
      reason: 'name-taken',
    });
    const named = (await root.store.missions.listTokens(mission.id)).filter(
      (t) => t.holder.kind === 'named',
    );
    expect(named).toHaveLength(1);
  });

  it('nothing happened meanwhile: the token is issued, as before', async () => {
    const calm = teamWhere(async () => undefined);
    const result = await calm.generateToken(bob, mission.id);
    expect(result.ok).toBe(true);
    expect(await activeTokensOf(bob.id)).toBe(1);
  });
});
