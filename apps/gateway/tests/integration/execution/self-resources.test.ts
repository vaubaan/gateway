/**
 * SEC 2026-10-15 H1 — the instance's own resources are never reachable by a
 * mission (handbook configuration, "Self resources"). The Depot fixture
 * stands in for Railway: `VAUBAAN_SELF_RESOURCES=depot:app-prod` plays the
 * part of `RAILWAY_PROJECT_ID`.
 *
 *   issuance   flagged in the issuance context, left out of "all", refused
 *              when selected explicitly (`resource-self`);
 *   execution  a mission whose stored selection already holds it (issued
 *              before the instance knew, or written by hand) cannot reach
 *              it: the door refuses the call, nothing reaches the plugin;
 *   detail     the mission page and the kit do not list it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { issueTokenTo } from '../../../src/server/missions/token-issuer';
import { mintMissionToken } from '../../../src/server/missions/token';
import {
  executionInstance,
  line,
  type ExecutionInstance,
  type IssuedMission,
} from '../../../src/server/execution/testing';

const SELF = 'app-prod';

describe('self resources: never reachable by a mission', () => {
  let instance: ExecutionInstance;

  beforeEach(async () => {
    instance = await executionInstance({ env: { VAUBAAN_SELF_RESOURCES: `depot:${SELF}` } });
  });
  afterEach(async () => {
    await instance.close();
  });

  /** A mission stored with every space selected, the self one included: what the store may hold. */
  async function storedWithSelf(): Promise<IssuedMission> {
    const { root, ada, connection, resources } = instance;
    const mission = await root.store.missions.create({
      name: 'Issued before the instance knew its own project',
      creatorUserId: ada.id,
      periodSeconds: 86_400,
      connections: [
        {
          connectionId: connection.id,
          resourceScope: 'selected',
          resourceIds: resources.map((r) => r.id),
        },
      ],
      policy: [
        {
          riskId: 'depot.read',
          quota: 100,
          rateLimit: 1000,
          rateWindowSeconds: 60,
          gate: 'auto',
        },
      ],
    });
    const token = await issueTokenTo(
      { missions: root.store.missions, mint: mintMissionToken },
      { missionId: mission.id, holder: { kind: 'member', userId: ada.id }, createdBy: ada.id },
    );
    return { mission, token: token.secret, prefix: token.prefix };
  }

  it('reads the configured self resource', () => {
    expect(instance.root.config.selfResources).toEqual([
      { provider: 'depot', ref: SELF, source: 'config' },
    ]);
  });

  it('flags it at issuance, leaves it out of "all", refuses it when selected', async () => {
    const { root, ada, connection } = instance;
    const context = await root.missions.service.issuanceContext(ada);
    const listed = context.find((c) => c.id === connection.id)?.resources ?? [];
    expect(listed.filter((r) => r.self).map((r) => r.ref)).toEqual([SELF]);

    const all = await instance.issue({ policy: [line('depot.read')] });
    const stored = all.mission.connections[0]?.resourceIds ?? [];
    const selfId = instance.resources.find((r) => r.ref === SELF)!.id;
    expect(stored).not.toContain(selfId);
    expect(stored).toHaveLength(2);

    const picked = await root.missions.service.issue(ada, {
      name: 'Picks the host',
      connections: [
        {
          connection_id: connection.id,
          resources: { scope: 'selected', resource_refs: ['scratch', SELF] },
          policy: [line('depot.read')],
        },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    expect(picked.ok).toBe(false);
    expect(JSON.stringify(picked)).toContain('resource-self');
  });

  it('refuses at execution a call on it, even when the stored selection holds it', async () => {
    const mission = await storedWithSelf();
    const seen = instance.depot.calls.length;

    const refused = await instance.call(mission, 'depot__read_item', { space: SELF });
    expect(refused.error).toBeDefined();
    expect(refused.error?.data).toMatchObject({ code: 'resource-not-in-mission', cited_ref: SELF });
    expect(JSON.stringify(refused.error?.data?.allowed_resources)).not.toContain(SELF);
    expect(instance.depot.calls.length).toBe(seen);

    // The other spaces of the same mission still work.
    const allowed = await instance.call(mission, 'depot__read_item', { space: 'scratch' });
    expect(allowed.error).toBeUndefined();
    expect(instance.depot.calls.length).toBe(seen + 1);
  });

  it('is not listed on the mission page nor in the kit', async () => {
    const { mission } = await storedWithSelf();
    const detail = await instance.root.missions.service.get(instance.ada, mission.id);
    expect(detail?.connections[0]?.resources.map((r) => r.ref).sort()).toEqual([
      'app-staging',
      'scratch',
    ]);
    expect(detail?.kit?.agent_instructions ?? '').not.toContain(`\`${SELF}\``);
  });
});
