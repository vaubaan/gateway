/**
 * What the authority re-check adds to a call at the execution door (handbook
 * authority, Start here). A measurement, not an assertion: timing bounds are
 * flaky on shared runners, so the suite is skipped unless asked for.
 *
 *   VAUBAAN_BENCH=1 npx vitest run apps/gateway/tests/integration/authority/door-latency.bench.test.ts
 *
 * It prints the mean cost of `MissionGrounds.inspect` for the three shapes a
 * mission can be grounded in, next to the mean of a whole `tools/call`
 * through the door on the same instance (`:memory:` store, echo plugin).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { line, type IssuedMission } from '../../../src/server/execution/testing';
import { authorityRig, READ, type AuthorityRig } from './support';

const SETTLE_ITERATIONS = 20_000;
const CALL_ITERATIONS = 2_000;
// Neither the surface rate limit nor the budget must be what the loop measures.
const UNLIMITED = { VAUBAAN_MCP_RATE_LIMIT_PER_MINUTE: '1000000' };
const roomy = (riskId: string) =>
  line(riskId, 10_000_000, { rate_limit: { max: 10_000_000, window_seconds: 60 } });

async function meanMicros(iterations: number, run: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < 200; i += 1) await run(); // warm-up
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) await run();
  return Number(process.hrtime.bigint() - start) / 1000 / iterations;
}

describe.skipIf(!process.env.VAUBAAN_BENCH)('latency of the authority re-check', () => {
  let rig: AuthorityRig;
  const shapes: { name: string; mission: IssuedMission }[] = [];

  beforeAll(async () => {
    rig = await authorityRig({ env: UNLIMITED });
    const { store, shares, groups } = rig.root;

    // 1. The creator owns the connection in their own name.
    shapes.push({
      name: 'owner (user)',
      mission: await rig.issueFor(rig.ada, [READ], 'Owner', roomy),
    });

    // 2. The creator holds a share made to one of their five groups.
    for (const name of ['g1', 'g2', 'g3', 'g4', 'readers']) {
      const group = await store.groups.getOrCreate(name, 'idp');
      await store.groups.addMember(group.id, rig.bob.id);
    }
    const readers = (await store.groups.getByName('readers'))!;
    await shares.service.share(await rig.actor(rig.ada), rig.connection.id, {
      target: { kind: 'group', groupId: readers.id },
      riskIds: [READ],
    });
    shapes.push({
      name: 'share (via a group)',
      mission: await rig.issueFor(rig.bob, [READ], 'Shared', roomy),
    });

    // 3. The creator owns a second connection through a group.
    const owners = await groups.service.create(rig.operator.id, 'owners');
    await groups.service.addMember(rig.operator.id, owners.id, 'ops@example.com');
    const second = await store.connections.create({
      provider: rig.connection.provider,
      owner: { kind: 'group', id: owners.id },
      displayName: 'Depot of the group',
      credential: await store.connections.getCredential(rig.connection.id),
    });
    await store.connections.syncDiscoveredResources(second.id, [
      { ref: 'scratch', displayName: 'scratch' },
    ]);
    const issued = await rig.root.missions.service.issue(rig.operator, {
      name: 'Group owner',
      connections: [
        { connection_id: second.id, resources: { scope: 'all' }, policy: [roomy(READ)] },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    if (!issued.ok) throw new Error('issue refused');
    shapes.push({
      name: 'owner (group)',
      mission: { mission: issued.mission, token: issued.token.secret, prefix: issued.token.prefix },
    });
  }, 60_000);
  afterAll(async () => {
    await rig.close();
  });

  it('prints the cost of inspect() and of a whole call', async () => {
    const lines: string[] = [];
    for (const { name, mission } of shapes) {
      const record = (await rig.root.store.missions.getById(mission.mission.id))!;
      const settle = await meanMicros(SETTLE_ITERATIONS, () =>
        rig.root.authority.grounds.inspect(record),
      );
      const call = await meanMicros(CALL_ITERATIONS, () => rig.read(mission));
      expect((await rig.read(mission)).result).toBeDefined();
      lines.push(
        `${name.padEnd(22)} inspect ${settle.toFixed(1).padStart(7)} µs   tools/call ${call
          .toFixed(1)
          .padStart(8)} µs   share of the call ${((settle / call) * 100).toFixed(1)} %`,
      );
    }
    // eslint-disable-next-line no-console -- the point of the bench is to print
    console.log(`\nauthority re-check, mean per call\n${lines.join('\n')}\n`);
  }, 600_000);
});
