/**
 * The store side of "what a mission creates, it reaches" (ADR
 * created-resources-join-the-mission; migration 0024):
 *
 *   - `AccountsRepo.upsertDiscoveredResources` inserts a created ref or clears its
 *     stale flag, keeps owner edits, merges service facts, touches no other row;
 *   - `syncDiscoveredResources` does not mark stale a row first seen less than
 *     `FRESH_RESOURCE_STALE_GRACE_MS` ago;
 *   - `MissionsRepo.addResources` adds to an explicit selection with its source, turns
 *     an empty `all` into `selected`, writes nothing under `account`, and records a
 *     `resources-created` event in the mission log;
 *   - `MissionsRepo.edit` stores the resource rows it adds with source `edit`
 *     (ADR mission-editable-after-issuance) and leaves the kept rows' source alone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FRESH_RESOURCE_STALE_GRACE_MS,
  InvariantError,
  NotFoundError,
  type MissionPolicyLineInput,
  type Store,
} from '../../../src/server/store/index.ts';
import {
  firstSetOf,
  flatAccounts,
  openTestStore,
  type TestStore,
} from '../../support/store/testing.ts';

const POLICY: MissionPolicyLineInput[] = [
  { riskId: 'github.code-read', quota: 100, rateLimit: 30, rateWindowSeconds: 60, gate: 'auto' },
];
const MINUTE = 60_000;

describe('created resources in the store', () => {
  let t: TestStore;
  let store: Store;
  let creator: string;
  let account: string;
  let other: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    creator = (
      await store.users.upsertFromIdp({ issuer: 'http://idp.test', subject: 'c', email: 'c@x' })
    ).id;
    const create = (service: string) =>
      store.accounts.create({
        service,
        owner: { kind: 'user', id: creator },
        displayName: service,
        credential: null,
      });
    account = (await create('github')).id;
    other = (await create('supabase')).id;
    await store.accounts.syncDiscoveredResources(account, [
      { ref: 'acme/a', displayName: 'A', metadata: { kept: 1, replaced: 'old' } },
      { ref: 'acme/b', displayName: 'B' },
    ]);
  });
  afterEach(() => store.close());

  const rows = () => store.accounts.listResources(account);
  const row = async (ref: string) => (await rows()).find((r) => r.ref === ref);

  describe('upsertDiscoveredResources', () => {
    it('inserts a new ref, unlabelled so it reads the account default; other rows untouched', async () => {
      await store.accounts.setDefaultEnv(account, 'staging');
      const before = await rows();
      t.clock.advance(MINUTE);
      const [created, ...more] = await store.accounts.upsertDiscoveredResources(account, [
        { ref: 'acme/new', displayName: 'New', metadata: { url: 'u' } },
      ]);
      expect(more).toEqual([]);
      expect(created).toMatchObject({
        ref: 'acme/new',
        displayName: 'New',
        env: 'staging',
        envSource: 'account-default',
        metadata: { url: 'u' },
        staleSince: null,
      });
      const after = await rows();
      expect(after.filter((r) => r.ref !== 'acme/new')).toEqual(before);
    });

    it('a known ref: stale flag cleared, service facts merged, owner edits kept', async () => {
      const a = (await row('acme/a'))!;
      await store.accounts.setResourceDisplayName(a.id, 'Owner name');
      await store.accounts.setResourceEnv(a.id, 'prod');
      await store.accounts.setResourceHidden(a.id, true);
      t.clock.advance(FRESH_RESOURCE_STALE_GRACE_MS + MINUTE);
      await store.accounts.syncDiscoveredResources(account, [{ ref: 'acme/b', displayName: 'B' }]);
      expect((await row('acme/a'))?.staleSince).not.toBeNull();

      const [again] = await store.accounts.upsertDiscoveredResources(account, [
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

    it('returns the rows of the given refs only, once each, and refuses an unknown account', async () => {
      const got = await store.accounts.upsertDiscoveredResources(account, [
        { ref: 'acme/x', displayName: 'X' },
        { ref: 'acme/x', displayName: 'X again' },
      ]);
      expect(got.map((r) => [r.ref, r.displayName])).toEqual([['acme/x', 'X']]);
      await expect(
        store.accounts.upsertDiscoveredResources('nope', [{ ref: 'r', displayName: 'r' }]),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('the stale grace of a fresh row', () => {
    it('a discovery that misses a row first seen within 15 minutes keeps it; past that, stale', async () => {
      t.clock.advance(MINUTE);
      await store.accounts.upsertDiscoveredResources(account, [
        { ref: 'acme/new', displayName: 'New' },
      ]);
      const listed = [
        { ref: 'acme/a', displayName: 'A' },
        { ref: 'acme/b', displayName: 'B' },
      ];
      t.clock.advance(FRESH_RESOURCE_STALE_GRACE_MS - MINUTE);
      await store.accounts.syncDiscoveredResources(account, listed);
      expect((await row('acme/new'))?.staleSince).toBeNull();

      t.clock.advance(2 * MINUTE);
      await store.accounts.syncDiscoveredResources(account, listed);
      expect((await row('acme/new'))?.staleSince).toBe(t.clock.now().toISOString());
    });

    it('a stale row that comes back is fresh again: protected anew', async () => {
      t.clock.advance(FRESH_RESOURCE_STALE_GRACE_MS + MINUTE);
      await store.accounts.syncDiscoveredResources(account, [{ ref: 'acme/b', displayName: 'B' }]);
      expect((await row('acme/a'))?.staleSince).not.toBeNull();
      t.clock.advance(MINUTE);
      await store.accounts.upsertDiscoveredResources(account, [
        { ref: 'acme/a', displayName: 'A' },
      ]);
      t.clock.advance(MINUTE);
      await store.accounts.syncDiscoveredResources(account, [{ ref: 'acme/b', displayName: 'B' }]);
      expect((await row('acme/a'))?.staleSince).toBeNull();
    });
  });

  describe('MissionsRepo.addResources', () => {
    const mission = (ids: string[] = [], future = false) =>
      store.missions.create({
        name: 'm',
        creatorUserId: creator,
        periodSeconds: 86_400,
        accounts: [{ accountId: account, resourceIds: ids, future }],
        policy: POLICY,
      });
    const created = async () =>
      (
        await store.accounts.upsertDiscoveredResources(account, [
          { ref: 'acme/new', displayName: 'New' },
        ])
      )[0]!;

    it('adds to a list with source `created`, read back on the mission', async () => {
      const a = (await row('acme/a'))!;
      const m = await mission([a.id]);
      const fresh = await created();
      const result = await store.missions.addResources(m.id, account, [fresh.id], 'created');
      expect(result).toEqual({
        placed: [{ resourceId: fresh.id, resourceSetId: firstSetOf(m) }],
        added: [fresh.id],
      });
      const stored = await store.missions.getById(m.id);
      expect(flatAccounts(stored!)[0]).toEqual({
        accountId: account,
        resourceIds: [a.id, fresh.id].sort(),
        resourceSources: { [fresh.id]: 'created' },
      });
      // Again: nothing repeated, the source kept.
      expect(await store.missions.addResources(m.id, account, [fresh.id], 'edit')).toEqual({
        placed: [{ resourceId: fresh.id, resourceSetId: firstSetOf(m) }],
        added: [],
      });
      expect(flatAccounts((await store.missions.getById(m.id))!)[0]?.resourceSources).toEqual({
        [fresh.id]: 'created',
      });
    });

    describe('with several resource sets (risk model §4.7)', () => {
      /** Set 1 holds acme/a (prod), set 2 acme/b (staging, future), set 3 none (prod, future). */
      const threeSets = async () => {
        const a = await store.accounts.setResourceEnv((await row('acme/a'))!.id, 'prod');
        const b = await store.accounts.setResourceEnv((await row('acme/b'))!.id, 'staging');
        const set = (resourceIds: string[], future: boolean, env?: string) => ({
          resourceIds,
          future,
          ...(env !== undefined ? { env } : {}),
          policy: POLICY,
        });
        return store.missions.create({
          name: 'm',
          creatorUserId: creator,
          periodSeconds: 86_400,
          accounts: [
            {
              accountId: account,
              resourceSets: [set([a.id], false), set([b.id], true), set([], true, 'prod')],
            },
          ],
        });
      };
      const setIds = (m: { accounts: readonly { resourceSets: readonly { id: string }[] }[] }) =>
        m.accounts[0]!.resourceSets.map((x) => x.id);
      const fresh = async (ref: string, env: string) =>
        store.accounts.setResourceEnv(
          (await store.accounts.upsertDiscoveredResources(account, [{ ref, displayName: ref }]))[0]!
            .id,
          env,
        );
      const placedIn = (result: { placed: readonly { resourceSetId: string }[] }) =>
        result.placed[0]?.resourceSetId;

      it('joins the one set the call was judged against, whatever its environment', async () => {
        const m = await threeSets();
        const [, second] = setIds(m);
        const r = await fresh('acme/p1', 'prod');
        expect(
          placedIn(
            await store.missions.addResources(m.id, account, [r.id], 'created', undefined, [
              second!,
            ]),
          ),
        ).toBe(second);
      });

      it('judged against several: the candidate with future on in its environment, else one in its environment', async () => {
        const m = await threeSets();
        const [first, second, third] = setIds(m);
        const p1 = await fresh('acme/p1', 'prod');
        expect(
          placedIn(
            await store.missions.addResources(m.id, account, [p1.id], 'created', undefined, [
              first!,
              third!,
            ]),
          ),
        ).toBe(third);
        const p2 = await fresh('acme/p2', 'prod');
        expect(
          placedIn(
            await store.missions.addResources(m.id, account, [p2.id], 'created', undefined, [
              first!,
              second!,
            ]),
          ),
        ).toBe(first);
      });

      it('judged against several, none in its environment: the first of them by position, never another set', async () => {
        const m = await threeSets();
        const [first, second] = setIds(m);
        const d1 = await fresh('acme/d1', 'dev');
        // Judged against set 2 only once the other candidate is gone: set 2, not set 1.
        expect(
          placedIn(
            await store.missions.addResources(m.id, account, [d1.id], 'created', undefined, [
              second!,
              'gone-set',
            ]),
          ),
        ).toBe(second);
        const d2 = await fresh('acme/d2', 'dev');
        expect(
          placedIn(
            await store.missions.addResources(m.id, account, [d2.id], 'created', undefined, [
              second!,
              first!,
            ]),
          ),
        ).toBe(first);
      });
    });

    it('records `resources-created` in the mission log', async () => {
      const m = await mission([], true);
      const missionLog = await store.missionLogs.getOrCreate(m.id);
      const fresh = await created();
      await store.missions.addResources(m.id, account, [fresh.id], 'created', {
        tool: 'github__create_repo',
        actorUserId: creator,
      });
      const events = await store.missionLogs.listEvents(missionLog.id);
      expect(events.map((e) => [e.kind, e.actorUserId, e.details])).toEqual([
        [
          'resources-created',
          creator,
          { tool: 'github__create_repo', account_id: account, refs: ['acme/new'] },
        ],
      ]);
    });

    it('refuses a resource of another account and an account the mission does not carry', async () => {
      const m = await mission();
      const [foreign] = await store.accounts.upsertDiscoveredResources(other, [
        { ref: 'proj', displayName: 'proj' },
      ]);
      await expect(
        store.missions.addResources(m.id, account, [foreign!.id], 'created'),
      ).rejects.toBeInstanceOf(InvariantError);
      await expect(
        store.missions.addResources(m.id, other, [foreign!.id], 'created'),
      ).rejects.toBeInstanceOf(NotFoundError);
      // Nothing written by the refused call.
      expect(flatAccounts((await store.missions.getById(m.id))!)[0]).toMatchObject({
        resourceIds: [],
      });
    });

    it('the source column refuses a value outside its set', async () => {
      const m = await mission();
      const b = (await row('acme/b'))!;
      const insert = (source: string) =>
        store.db
          .prepare(
            'INSERT INTO mission_resources (mission_id, account_id, resource_id, resource_set_id, source) VALUES (?, ?, ?, ?, ?)',
          )
          .run(m.id, account, b.id, firstSetOf(m), source);
      expect(() => insert('other')).toThrow(/CHECK/);
      expect(() => insert('future')).not.toThrow();
    });

    it('a resource the creator adds by an edit is stored with source `edit`; kept rows keep theirs', async () => {
      const a = (await row('acme/a'))!;
      const b = (await row('acme/b'))!;
      const m = await mission([a.id]);
      const fresh = await created();
      await store.missions.addResources(m.id, account, [fresh.id], 'created');
      const edited = await store.missions.edit(m.id, {
        actorUserId: creator,
        unchanged: () => true,
        name: m.name,
        expiresAt: null,
        accounts: [
          {
            accountId: account,
            resourceIds: [a.id, b.id, fresh.id],
          },
          { accountId: other, resourceIds: [], future: true },
        ],
        policy: POLICY,
        summary: (closed) => ({
          kind: 'mission-changed',
          details: {
            name_changed: false,
            expiry_changed: false,
            accounts_added: 1,
            accounts_removed: 0,
            resources_added: 1,
            resources_removed: 0,
            scopes_changed: 0,
            permissions_added: [],
            permissions_removed: [],
            limits: [],
            gates: [],
            requests_closed: closed,
          },
        }),
      });
      expect(edited).not.toBeNull();
      const stored = await store.missions.getById(m.id);
      expect(flatAccounts(stored!).find((c) => c.accountId === account)).toEqual({
        accountId: account,
        resourceIds: [a.id, b.id, fresh.id].sort(),
        resourceSources: { [b.id]: 'edit', [fresh.id]: 'created' },
      });
    });
  });
});
