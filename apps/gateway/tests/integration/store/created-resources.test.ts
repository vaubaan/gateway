/**
 * The store side of "what a mission creates, it reaches" (ADR
 * created-resources-join-the-mission; migration 0024):
 *
 *   - `ConnectionsRepo.upsertDiscoveredResources` inserts a created ref or clears its
 *     stale flag, keeps owner edits, merges provider facts, touches no other row;
 *   - `syncDiscoveredResources` does not mark stale a row first seen less than
 *     `FRESH_RESOURCE_STALE_GRACE_MS` ago;
 *   - `MissionsRepo.addResources` adds to an explicit selection with its source, turns
 *     an empty `all` into `selected`, writes nothing under `connection`, and records a
 *     `resources-created` event in the mission's session.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FRESH_RESOURCE_STALE_GRACE_MS,
  InvariantError,
  NotFoundError,
  type MissionPolicyEntry,
  type Store,
} from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

const POLICY: MissionPolicyEntry[] = [
  { riskId: 'github.code-read', quota: 100, rateLimit: 30, rateWindowSeconds: 60, gate: 'auto' },
];
const MINUTE = 60_000;

describe('created resources in the store', () => {
  let t: TestStore;
  let store: Store;
  let creator: string;
  let connection: string;
  let other: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    creator = (
      await store.users.upsertFromIdp({ issuer: 'http://idp.test', subject: 'c', email: 'c@x' })
    ).id;
    const create = (provider: string) =>
      store.connections.create({
        provider,
        owner: { kind: 'user', id: creator },
        displayName: provider,
        credential: null,
      });
    connection = (await create('github')).id;
    other = (await create('supabase')).id;
    await store.connections.syncDiscoveredResources(connection, [
      { ref: 'acme/a', displayName: 'A', metadata: { kept: 1, replaced: 'old' } },
      { ref: 'acme/b', displayName: 'B' },
    ]);
  });
  afterEach(() => store.close());

  const rows = () => store.connections.listResources(connection);
  const row = async (ref: string) => (await rows()).find((r) => r.ref === ref);

  describe('upsertDiscoveredResources', () => {
    it('inserts a new ref, unlabelled so it reads the connection default; other rows untouched', async () => {
      await store.connections.setDefaultEnv(connection, 'staging');
      const before = await rows();
      t.clock.advance(MINUTE);
      const [created, ...more] = await store.connections.upsertDiscoveredResources(connection, [
        { ref: 'acme/new', displayName: 'New', metadata: { url: 'u' } },
      ]);
      expect(more).toEqual([]);
      expect(created).toMatchObject({
        ref: 'acme/new',
        displayName: 'New',
        env: 'staging',
        envSource: 'connection-default',
        metadata: { url: 'u' },
        staleSince: null,
      });
      const after = await rows();
      expect(after.filter((r) => r.ref !== 'acme/new')).toEqual(before);
    });

    it('a known ref: stale flag cleared, provider facts merged, owner edits kept', async () => {
      const a = (await row('acme/a'))!;
      await store.connections.setResourceDisplayName(a.id, 'Owner name');
      await store.connections.setResourceEnv(a.id, 'prod');
      await store.connections.setResourceHidden(a.id, true);
      t.clock.advance(FRESH_RESOURCE_STALE_GRACE_MS + MINUTE);
      await store.connections.syncDiscoveredResources(connection, [
        { ref: 'acme/b', displayName: 'B' },
      ]);
      expect((await row('acme/a'))?.staleSince).not.toBeNull();

      const [again] = await store.connections.upsertDiscoveredResources(connection, [
        { ref: 'acme/a', displayName: 'Upstream', metadata: { replaced: 'new', url: 'u' } },
      ]);
      expect(again).toMatchObject({
        id: a.id,
        displayName: 'Owner name',
        env: 'prod',
        hidden: true,
        staleSince: null,
        metadata: { kept: 1, replaced: 'new', url: 'u' },
      });
    });

    it('returns the rows of the given refs only, once each, and refuses an unknown connection', async () => {
      const got = await store.connections.upsertDiscoveredResources(connection, [
        { ref: 'acme/x', displayName: 'X' },
        { ref: 'acme/x', displayName: 'X again' },
      ]);
      expect(got.map((r) => [r.ref, r.displayName])).toEqual([['acme/x', 'X']]);
      await expect(
        store.connections.upsertDiscoveredResources('nope', [{ ref: 'r', displayName: 'r' }]),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('the stale grace of a fresh row', () => {
    it('a discovery that misses a row first seen within 15 minutes keeps it; past that, stale', async () => {
      t.clock.advance(MINUTE);
      await store.connections.upsertDiscoveredResources(connection, [
        { ref: 'acme/new', displayName: 'New' },
      ]);
      const listed = [
        { ref: 'acme/a', displayName: 'A' },
        { ref: 'acme/b', displayName: 'B' },
      ];
      t.clock.advance(FRESH_RESOURCE_STALE_GRACE_MS - MINUTE);
      await store.connections.syncDiscoveredResources(connection, listed);
      expect((await row('acme/new'))?.staleSince).toBeNull();

      t.clock.advance(2 * MINUTE);
      await store.connections.syncDiscoveredResources(connection, listed);
      expect((await row('acme/new'))?.staleSince).toBe(t.clock.now().toISOString());
    });

    it('a stale row that comes back is fresh again: protected anew', async () => {
      t.clock.advance(FRESH_RESOURCE_STALE_GRACE_MS + MINUTE);
      await store.connections.syncDiscoveredResources(connection, [
        { ref: 'acme/b', displayName: 'B' },
      ]);
      expect((await row('acme/a'))?.staleSince).not.toBeNull();
      t.clock.advance(MINUTE);
      await store.connections.upsertDiscoveredResources(connection, [
        { ref: 'acme/a', displayName: 'A' },
      ]);
      t.clock.advance(MINUTE);
      await store.connections.syncDiscoveredResources(connection, [
        { ref: 'acme/b', displayName: 'B' },
      ]);
      expect((await row('acme/a'))?.staleSince).toBeNull();
    });
  });

  describe('MissionsRepo.addResources', () => {
    const mission = (scope: 'all' | 'selected' | 'connection', ids: string[] = []) =>
      store.missions.create({
        name: 'm',
        creatorUserId: creator,
        periodSeconds: 86_400,
        connections: [{ connectionId: connection, resourceScope: scope, resourceIds: ids }],
        policy: POLICY,
      });
    const created = async () =>
      (
        await store.connections.upsertDiscoveredResources(connection, [
          { ref: 'acme/new', displayName: 'New' },
        ])
      )[0]!;

    it('adds to a selected list with source `created`, read back on the mission', async () => {
      const a = (await row('acme/a'))!;
      const m = await mission('selected', [a.id]);
      const fresh = await created();
      const result = await store.missions.addResources(m.id, connection, [fresh.id], 'created');
      expect(result).toEqual({ scope: 'selected', added: [fresh.id] });
      const stored = await store.missions.getById(m.id);
      expect(stored?.connections[0]).toEqual({
        connectionId: connection,
        resourceScope: 'selected',
        resourceIds: [a.id, fresh.id].sort(),
        resourceSources: { [fresh.id]: 'created' },
      });
      // Again: nothing repeated, the source kept.
      expect(await store.missions.addResources(m.id, connection, [fresh.id], 'edit')).toEqual({
        scope: 'selected',
        added: [],
      });
      expect((await store.missions.getById(m.id))?.connections[0]?.resourceSources).toEqual({
        [fresh.id]: 'created',
      });
    });

    it('an `all` that stored nothing becomes `selected`', async () => {
      const m = await mission('all');
      const fresh = await created();
      expect(await store.missions.addResources(m.id, connection, [fresh.id], 'created')).toEqual({
        scope: 'selected',
        added: [fresh.id],
      });
      expect((await store.missions.getById(m.id))?.connections[0]).toMatchObject({
        resourceScope: 'selected',
        resourceIds: [fresh.id],
      });
    });

    it('scope `connection` writes nothing: it reaches the resource already', async () => {
      const m = await mission('connection');
      const fresh = await created();
      expect(await store.missions.addResources(m.id, connection, [fresh.id], 'created')).toEqual({
        scope: 'connection',
        added: [],
      });
      expect((await store.missions.getById(m.id))?.connections[0]).toEqual({
        connectionId: connection,
        resourceScope: 'connection',
        resourceIds: [],
      });
    });

    it('records `resources-created` in the session, whatever the scope', async () => {
      const m = await mission('connection');
      const session = await store.sessions.getOrCreate(m.id);
      const fresh = await created();
      await store.missions.addResources(m.id, connection, [fresh.id], 'created', {
        tool: 'github__create_repo',
        actorUserId: creator,
      });
      const events = await store.sessions.listEvents(session.id);
      expect(events.map((e) => [e.kind, e.actorUserId, e.details])).toEqual([
        [
          'resources-created',
          creator,
          { tool: 'github__create_repo', connection_id: connection, refs: ['acme/new'] },
        ],
      ]);
    });

    it('refuses a resource of another connection and a connection the mission does not carry', async () => {
      const m = await mission('all');
      const [foreign] = await store.connections.upsertDiscoveredResources(other, [
        { ref: 'proj', displayName: 'proj' },
      ]);
      await expect(
        store.missions.addResources(m.id, connection, [foreign!.id], 'created'),
      ).rejects.toBeInstanceOf(InvariantError);
      await expect(
        store.missions.addResources(m.id, other, [foreign!.id], 'created'),
      ).rejects.toBeInstanceOf(NotFoundError);
      // Nothing written by the refused call.
      expect((await store.missions.getById(m.id))?.connections[0]).toMatchObject({
        resourceScope: 'all',
        resourceIds: [],
      });
    });

    it('the source column refuses a value outside its set', async () => {
      const m = await mission('all');
      const b = (await row('acme/b'))!;
      const insert = (source: string) =>
        store.db
          .prepare(
            'INSERT INTO mission_resources (mission_id, connection_id, resource_id, source) VALUES (?, ?, ?, ?)',
          )
          .run(m.id, connection, b.id, source);
      expect(() => insert('other')).toThrow(/CHECK/);
      expect(() => insert('edit')).not.toThrow();
    });
  });
});
