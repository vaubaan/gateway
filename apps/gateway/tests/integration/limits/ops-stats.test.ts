/**
 * `GET /ops/stats` over the real composition root (spec §4.3 bis): the counts the
 * ceilings read, the calls of the day, the store and the keys — and nothing that
 * names a person, an item or a resource. The telemetry's instance profile reads the
 * same counts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GatewayRoot } from '../../../src/server/compose/root';
import { opsStatsResponse } from '../../../src/server/http';
import type { OpsStats } from '../../../src/server/limits';
import {
  auditRigOn,
  githubDraft,
  issueMission,
  OPERATOR_EMAIL,
  READ,
  seedCall,
  type AuditRig,
} from '../audit/support';
import { buildTestRoot, PUBLIC_URL, seedInstance } from '../missions/support';

const TOKEN = 'ops-token-for-the-monitoring-of-this-test-instance';

describe('the counters endpoint', () => {
  let root: GatewayRoot;
  let rig: AuditRig;

  beforeEach(async () => {
    root = await buildTestRoot({
      env: {
        VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL,
        VAUBAAN_OPS_TOKEN: TOKEN,
        VAUBAAN_LIMITS_USERS: '10',
        VAUBAAN_LIMITS_ACTIVE_MISSIONS: '5',
      },
    });
    rig = auditRigOn(root, await seedInstance(root));
  });
  afterEach(async () => {
    await root.close();
  });

  const read = (authorization: string | null) =>
    opsStatsResponse(
      new Request(`${PUBLIC_URL}/ops/stats`, {
        headers: authorization ? { authorization } : {},
      }),
      root.opsStats,
    );

  it('answers the counts of the instance to the bearer of ops.token, and only to them', async () => {
    expect((await read(null)).status).toBe(401);
    expect((await read('Bearer not-the-token-of-this-instance-at-all')).status).toBe(401);

    const mission = await issueMission(rig, rig.seeded.ada, githubDraft(rig));
    expect((await seedCall(rig, mission, { risks: [READ] })).result.outcome).toBe('allowed');
    const revoked = await issueMission(rig, rig.seeded.ada, githubDraft(rig));
    await root.missions.service.revoke(rig.seeded.ada, revoked.id);
    await root.store.connections.revoke(rig.seeded.gmail.connection.id);

    const res = await read(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    const body = JSON.parse(text) as OpsStats;
    expect(body).toMatchObject({
      users: 2,
      connections: { total: 3, by_provider: { github: 1, supabase: 1, vercel: 1 } },
      active_missions: 1,
      calls_today: { allowed: 1, refused: 0 },
      store: { kind: 'memory' },
      keys: { current_version: 1 },
      limits: { users: 10, connections: null, active_missions: 5 },
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        'active_missions',
        'calls_today',
        'connections',
        'generated_at',
        'keys',
        'limits',
        'store',
        'users',
      ].sort(),
    );
    expect(body.store.bytes).toBeGreaterThan(0);
    expect(Date.parse(body.calls_today.since)).toBeLessThanOrEqual(Date.parse(body.generated_at));
    expect(body.calls_today.since).toMatch(/T00:00:00\.000Z$/);
    // The sealed credentials of the three live connections, under version 1.
    expect(body.keys.sealed_by_version['1']).toBeGreaterThanOrEqual(3);

    // Counts only: no person, item, resource or configuration value.
    const named = [
      rig.seeded.ada.id,
      rig.seeded.ada.email,
      rig.seeded.bob.email,
      mission.id,
      mission.name,
      rig.seeded.github.connection.id,
      rig.seeded.github.connection.displayName,
      ...rig.seeded.github.resources.map((r) => r.ref),
      'gateway.example.com',
      TOKEN,
    ];
    for (const value of named) expect(text, value).not.toContain(value);
  });

  it('the telemetry profile and the ceilings read the same counts', async () => {
    await issueMission(rig, rig.seeded.ada, githubDraft(rig));
    const listed = (await root.store.connections.list()).filter((c) => c.status !== 'revoked');
    const byProvider: Record<string, number> = {};
    for (const c of listed) byProvider[c.provider] = (byProvider[c.provider] ?? 0) + 1;
    const users = (await root.store.users.list()).filter((u) => u.status === 'active').length;

    expect(await root.limits.counts.users()).toBe(users);
    expect(await root.limits.counts.connections()).toEqual({
      total: listed.length,
      byProvider,
    });
    expect(await root.limits.usage()).toEqual([
      { ceiling: 'users', count: users, limit: 10 },
      { ceiling: 'connections', count: listed.length, limit: null },
      { ceiling: 'active-missions', count: 1, limit: 5 },
    ]);
  });
});

describe('without ops.token', () => {
  it('the endpoint does not exist', async () => {
    const root = await buildTestRoot();
    try {
      const res = await opsStatsResponse(
        new Request(`${PUBLIC_URL}/ops/stats`, { headers: { authorization: `Bearer ${TOKEN}` } }),
        root.opsStats,
      );
      expect(res.status).toBe(404);
    } finally {
      await root.close();
    }
  });
});
