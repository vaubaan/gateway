/**
 * Future resources (spec §3.1 "Resource selection"; ADR
 * resource-set-is-one-environment-with-optional-future-resources), over the real
 * composition root and the Depot test plugin.
 *
 * What is proven here:
 *
 *   - a discovery writes a new resource into the set with future on of its environment,
 *     audited on the mission (`mission-resource-joined`, reason `discovered`); a set
 *     without future, another environment, a hidden resource and the instance's own
 *     take nothing;
 *   - an owner's relabel moves a held resource out of a set of another environment and
 *     into the future set of its new one, else out of the mission; changing the
 *     account's default relabels what inherits it, with the same moves;
 *   - a legacy set mixing environments (migration 0033) takes any environment and keeps
 *     what is relabelled; a stopped mission moves nothing;
 *   - the hourly discovery runs on the accounts a running future set depends on, one
 *     run at a time, and logs a failure without the service's words;
 *   - "check now" is the creator's or an owner's, says what joined, and the mission page
 *     reads when the account was last checked.
 */
import type { Resource } from '@vaubaan/plugin-sdk';
import { DISCOVERY_ACTOR_ID } from '@vaubaan/gateway-core';
import { afterEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth/cookies';
import type { ConnectError, DiscoveryTimers } from '../../../src/server/accounts';
import type { UserRecord } from '../../../src/server/store/types';
import {
  DEPOT,
  executionInstance,
  line,
  TEST_PUBLIC_URL,
  type ExecutionInstance,
  type ExecutionInstanceOptions,
  type IssuedMission,
  type SeedSpace,
} from '../../support/execution/testing';

const READ = 'depot.read';
const SPACES: readonly SeedSpace[] = [
  { ref: 'app-staging', env: 'staging' },
  { ref: 'app-prod', env: 'prod' },
];

const space = (ref: string, env?: string): Resource => ({
  service: DEPOT,
  ref,
  displayName: ref,
  ...(env ? { env } : {}),
});

describe('future resources', () => {
  let instance: ExecutionInstance;

  async function open(options: ExecutionInstanceOptions = {}): Promise<ExecutionInstance> {
    instance = await executionInstance({ spaces: SPACES, ...options });
    return instance;
  }
  afterEach(async () => {
    await instance.close();
  });

  /** The spaces labelled by their owner (a plugin's label is read-only): what a relabel moves. */
  async function openOwnerLabelled(spaces: readonly SeedSpace[] = SPACES): Promise<void> {
    await open({ spaces: spaces.map(({ ref }) => ({ ref })) });
    for (const { ref, env } of spaces) {
      if (env) await instance.root.store.accounts.setResourceEnv(await idOf(ref), env);
    }
  }

  const actorOf = async (user: UserRecord) => ({
    user,
    groups: await instance.root.store.groups.groupsOf(user.id),
  });
  const idOf = async (ref: string) =>
    (await instance.root.store.accounts.listResources(instance.account.id)).find(
      (r) => r.ref === ref,
    )?.id ?? '';
  /** The sets of the mission on the Depot account, by environment. */
  const setsOf = async (mission: IssuedMission) => {
    const stored = await instance.root.store.missions.getById(mission.mission.id);
    return stored?.accounts[0]?.resourceSets ?? [];
  };
  const listOf = async (mission: IssuedMission, env: string | null) =>
    (await setsOf(mission)).find((set) => set.env === env)?.resourceIds ?? [];
  const moves = async (act: 'mission-resource-joined' | 'mission-resource-left') =>
    (await instance.root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' && e.act === act
        ? [{ user: e.user_id, mission: e.object.id, after: e.after }]
        : [],
    );
  /** A discovery the owner runs, the service answering `listed`. */
  const discover = async (listed: readonly Resource[]) => {
    instance.depot.scriptDiscovery(async () => [...listed]);
    return instance.root.accounts.service.discover(
      await actorOf(instance.ada),
      instance.account.id,
    );
  };
  const both = (future: boolean) =>
    instance.issue({ policy: [line(READ)], ...(future ? { wholeAccount: true } : {}) });

  it('a discovery writes a new resource into the future set of its environment, audited', async () => {
    await open();
    const withFuture = await both(true);
    const without = await both(false);
    await discover([
      space('app-staging', 'staging'),
      space('app-prod', 'prod'),
      space('new-stg', 'staging'),
    ]);

    const fresh = await idOf('new-stg');
    expect(await listOf(withFuture, 'staging')).toContain(fresh);
    expect(await listOf(withFuture, 'prod')).not.toContain(fresh);
    expect(await listOf(without, 'staging')).not.toContain(fresh);
    const staging = (await setsOf(withFuture)).find((set) => set.env === 'staging');
    expect(staging?.resourceSources).toEqual({ [fresh]: 'future' });
    expect(await moves('mission-resource-joined')).toEqual([
      {
        user: instance.ada.id,
        mission: withFuture.mission.id,
        after: {
          account_id: instance.account.id,
          resource_set_id: staging?.id,
          refs: ['new-stg'],
          reason: 'discovered',
        },
      },
    ]);
    // Reached from the next call, same key.
    const read = await instance.call(withFuture, 'depot__read_item', { space: 'new-stg' });
    expect(read.error).toBeUndefined();
  });

  it('nothing joins in an environment no future set has, nor the instance’s own resource', async () => {
    await open({ env: { VAUBAAN_SELF_RESOURCES: `${DEPOT}:host-stg` } });
    const mission = await both(true);
    await discover([
      space('app-staging', 'staging'),
      space('app-prod', 'prod'),
      space('dev-1', 'dev'),
      space('loose'),
      space('host-stg', 'staging'),
    ]);
    const held = (await setsOf(mission)).flatMap((set) => set.resourceIds);
    for (const ref of ['dev-1', 'loose', 'host-stg']) expect(held).not.toContain(await idOf(ref));
    expect(await moves('mission-resource-joined')).toEqual([]);
  });

  it('an owner’s relabel moves a resource to the future set of its new environment, else out of the mission', async () => {
    await openOwnerLabelled();
    const mission = await both(true);
    const listed = await both(false);
    const staging = await idOf('app-staging');
    const owner = await actorOf(instance.ada);

    await instance.root.accounts.service.updateResource(owner, instance.account.id, staging, {
      env: 'prod',
    });
    expect(await listOf(mission, 'staging')).not.toContain(staging);
    expect(await listOf(mission, 'prod')).toContain(staging);
    // Without future, the prod set does not take it: it leaves that mission.
    expect((await setsOf(listed)).flatMap((set) => set.resourceIds)).not.toContain(staging);
    const left = await moves('mission-resource-left');
    expect(left.map((m) => [m.mission, (m.after as { reason: string }).reason])).toEqual(
      expect.arrayContaining([
        [mission.mission.id, 'relabelled'],
        [listed.mission.id, 'relabelled'],
      ]),
    );
    expect(left.every((m) => m.user === instance.ada.id)).toBe(true);
    expect(
      (await moves('mission-resource-joined')).map((m) => [
        m.mission,
        (m.after as { refs: string[] }).refs,
      ]),
    ).toEqual([[mission.mission.id, ['app-staging']]]);
    // The door refuses it to the mission it left.
    const refused = await instance.call(listed, 'depot__read_item', { space: 'app-staging' });
    expect(refused.error?.data?.code).toBe('resource-not-in-mission');
  });

  it('a hidden resource relabelled into a future set’s environment does not join it', async () => {
    await openOwnerLabelled([...SPACES, { ref: 'archive', env: 'dev' }]);
    const mission = await both(true);
    const archive = await idOf('archive');
    const owner = await actorOf(instance.ada);
    await instance.root.accounts.service.updateResource(owner, instance.account.id, archive, {
      hidden: true,
    });
    await instance.root.accounts.service.updateResource(owner, instance.account.id, archive, {
      env: 'staging',
    });
    expect(await listOf(mission, 'staging')).not.toContain(archive);
  });

  it('a change of the account’s default relabels what inherits it: it joins, then moves', async () => {
    await open({ spaces: [...SPACES, { ref: 'loose' }] });
    const mission = await both(true);
    const loose = await idOf('loose');
    // Unlabelled at issuance: left out of every set (Depot needs a label).
    expect((await setsOf(mission)).flatMap((set) => set.resourceIds)).not.toContain(loose);

    const owner = await actorOf(instance.ada);
    await instance.root.accounts.service.setDefaultEnv(owner, instance.account.id, 'staging');
    expect(await listOf(mission, 'staging')).toContain(loose);
    await instance.root.accounts.service.setDefaultEnv(owner, instance.account.id, 'prod');
    expect(await listOf(mission, 'staging')).not.toContain(loose);
    expect(await listOf(mission, 'prod')).toContain(loose);
    expect(
      (await moves('mission-resource-joined')).map((m) => (m.after as { reason: string }).reason),
    ).toEqual(['relabelled', 'relabelled']);
  });

  it('a legacy set mixing environments takes any environment and keeps what is relabelled', async () => {
    await openOwnerLabelled();
    const mission = await instance.issue({
      policy: [line(READ)],
      spaces: ['app-staging'],
      name: 'Issued before 0033',
    });
    const [set] = await setsOf(mission);
    // What migration 0033 makes of a whole-account set spanning two environments.
    instance.root.store.db
      .prepare(
        'UPDATE mission_resource_sets SET future = 1, env = NULL, mixed_env = 1 WHERE id = ?',
      )
      .run(set!.id);
    // The service says nothing of the known spaces' environments: their owner's labels stay.
    await discover([space('app-staging'), space('app-prod'), space('new-dev', 'dev')]);
    expect((await setsOf(mission))[0]?.resourceIds).toContain(await idOf('new-dev'));

    const staging = await idOf('app-staging');
    await instance.root.accounts.service.updateResource(
      await actorOf(instance.ada),
      instance.account.id,
      staging,
      { env: 'prod' },
    );
    expect((await setsOf(mission))[0]?.resourceIds).toContain(staging);
  });

  it('a stopped mission moves nothing', async () => {
    await open();
    const mission = await both(true);
    await instance.root.missions.service.revoke(instance.ada, mission.mission.id);
    await discover([
      space('app-staging', 'staging'),
      space('app-prod', 'prod'),
      space('late', 'staging'),
    ]);
    expect(await listOf(mission, 'staging')).not.toContain(await idOf('late'));
  });

  describe('the hourly discovery', () => {
    /** Timers driven by hand: what is armed, and a way to fire it. */
    function manualTimers() {
      const armed: { fn: () => void; ms: number }[] = [];
      const timers: DiscoveryTimers = {
        setTimeout(fn, ms) {
          armed.push({ fn, ms });
          return armed.length;
        },
        clearTimeout() {
          armed.length = 0;
        },
      };
      return { timers, armed };
    }

    it('selects the accounts a running future set depends on, and runs once at a time', async () => {
      const { timers, armed } = manualTimers();
      const logged: string[] = [];
      await open({
        deps: {
          discoveryTimers: timers,
          logWrite: (line: string) => {
            logged.push(line);
          },
        },
      });
      const { missions } = instance.root.store;
      const now = new Date().toISOString();
      expect(await missions.accountsWithFutureSets(now)).toEqual([]);
      await both(false);
      expect(await missions.accountsWithFutureSets(now)).toEqual([]);
      const future = await both(true);
      expect(await missions.accountsWithFutureSets(now)).toEqual([instance.account.id]);

      // Armed at boot for one hour later; firing runs the discovery of that account.
      expect(armed.map((a) => a.ms)).toEqual([60 * 60 * 1000]);
      instance.depot.scriptDiscovery(async () => [
        space('app-staging', 'staging'),
        space('app-prod', 'prod'),
        space('hourly', 'prod'),
      ]);
      const hourly = instance.root.accounts.hourlyDiscovery;
      const [first, second] = [hourly.runOnce(), hourly.runOnce()];
      expect(first).toBe(second);
      expect(await first).toEqual({ accounts: [instance.account.id], failed: [] });
      expect(instance.depot.discoveries()).toBe(1);
      expect(await listOf(future, 'prod')).toContain(await idOf('hourly'));
      expect((await moves('mission-resource-joined'))[0]?.user).toBe(DISCOVERY_ACTOR_ID);

      // A failure is recorded and logged by account only, never the service's words.
      instance.depot.scriptDiscovery(async () => {
        throw new Error('upstream said: secret-token-123 is wrong');
      });
      expect(await hourly.runOnce()).toEqual({
        accounts: [instance.account.id],
        failed: [instance.account.id],
      });
      expect(logged.join('\n')).not.toContain('secret-token-123');

      // A revoked mission's set no longer asks for it.
      await instance.root.missions.service.revoke(instance.ada, future.mission.id);
      expect(await missions.accountsWithFutureSets(new Date().toISOString())).toEqual([]);
    });
  });

  describe('"check now" on a mission card', () => {
    const post = (missionId: string, body: unknown, cookie: string) =>
      new Request(`${TEST_PUBLIC_URL}/api/missions/${missionId}/resources/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: TEST_PUBLIC_URL, cookie },
        body: JSON.stringify(body),
      });

    it('runs the discovery for the creator and says what joined; the page reads when it ran', async () => {
      await open();
      const mission = await both(true);
      instance.depot.scriptDiscovery(async () => [
        space('app-staging', 'staging'),
        space('app-prod', 'prod'),
        space('checked', 'staging'),
      ]);
      const check = await instance.root.accounts.service.checkForMission(
        await actorOf(instance.ada),
        mission.mission.id,
        instance.account.id,
      );
      const staging = (await setsOf(mission)).find((set) => set.env === 'staging');
      expect(check).toMatchObject({
        account_id: instance.account.id,
        discovery: { ok: true, count: 3 },
        joined: [{ resource_set_id: staging?.id, refs: ['checked'], reason: 'discovered' }],
        left: [],
      });
      const detail = await instance.root.missions.service.get(instance.ada, mission.mission.id);
      expect(detail?.accounts[0]?.last_checked_at).toBe(check.last_checked_at);
      const discovered = (await instance.root.store.audit.list({ kind: 'admin' })).find(
        (e) => e.kind === 'admin' && e.act === 'resources-discovered',
      );
      expect(discovered?.kind === 'admin' && discovered.after).toMatchObject({
        cause: 'check-now',
        mission_id: mission.mission.id,
      });
    });

    it('is refused, as a missing mission, to anyone but the creator and the owners', async () => {
      await open();
      const mission = await both(true);
      const eve = await instance.root.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'idp|eve',
        email: 'eve@example.com',
        displayName: 'Eve',
      });
      await expect(
        instance.root.accounts.service.checkForMission(
          await actorOf(eve),
          mission.mission.id,
          instance.account.id,
        ),
      ).rejects.toMatchObject({ code: 'not-found' } satisfies Partial<ConnectError>);
      // An account the mission does not carry reads the same.
      await expect(
        instance.root.accounts.service.checkForMission(
          await actorOf(instance.ada),
          mission.mission.id,
          'conn-elsewhere',
        ),
      ).rejects.toMatchObject({ code: 'not-found' });

      // Over HTTP: 404 for a stranger, 400 for a body that names no account.
      const session = await instance.root.auth.sessions.create({
        kind: 'user',
        userId: eve.id,
        login: { email: eve.email, groups: [] },
      });
      const cookie = `${SESSION_COOKIE}=${session.id}`;
      const { handlers } = instance.root.accounts;
      const stranger = await handlers.checkMissionResources(
        post(mission.mission.id, { account_id: instance.account.id }, cookie),
        mission.mission.id,
      );
      expect(stranger.status).toBe(404);
      const malformed = await handlers.checkMissionResources(
        post(mission.mission.id, { account: instance.account.id }, cookie),
        mission.mission.id,
      );
      expect(malformed.status).toBe(400);
    });

    it('an owner of the account who did not create the mission may check it', async () => {
      await open();
      const bob = await instance.root.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'idp|bob',
        email: 'bob@example.com',
        displayName: 'Bob',
      });
      const group = (await instance.root.store.groups.createLocal('owners'))!;
      await instance.root.store.groups.addMember(group.id, instance.ada.id);
      await instance.root.store.groups.addMember(group.id, bob.id);
      await instance.root.store.accounts.transferOwner(instance.account.id, {
        kind: 'group',
        id: group.id,
      });
      const mission = await both(true);
      instance.depot.scriptDiscovery(async () => [
        space('app-staging', 'staging'),
        space('app-prod', 'prod'),
      ]);
      const check = await instance.root.accounts.service.checkForMission(
        await actorOf(bob),
        mission.mission.id,
        instance.account.id,
      );
      expect(check.discovery.ok).toBe(true);
    });
  });
});
