import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authorityRig,
  PROFILE,
  PURGE,
  READ,
  WRITE_PROD,
  WRITE_STAGING,
  type AuthorityRig,
} from '../../../tests/integration/authority/support';
import type { Actor } from '../connections';
import type { ShareInput } from './service';
import { labellingOf } from './service';

const toBob = (riskIds: readonly string[]): ShareInput => ({
  target: { kind: 'user', email: 'bob@example.com' },
  riskIds,
});

describe('ShareService', () => {
  let rig: AuthorityRig;
  let ada: Actor;

  beforeEach(async () => {
    rig = await authorityRig();
    ada = await rig.actor(rig.ada);
  });
  afterEach(async () => {
    await rig.close();
  });

  const share = (input: ShareInput) => rig.root.shares.service.share(ada, rig.connection.id, input);
  const stored = () => rig.root.store.shares.listForConnection(rig.connection.id);
  const restrictionRows = () =>
    rig.root.store.db
      .prepare<[], { risk_id: string }>('SELECT risk_id FROM share_restrictions ORDER BY risk_id')
      .all()
      .map((row) => row.risk_id);

  describe('share', () => {
    it('stores the restriction as one row per risk, in catalog order, and audits it', async () => {
      const outcome = await share(toBob([WRITE_STAGING, READ, READ]));
      expect(outcome.share).toMatchObject({
        connectionId: rig.connection.id,
        target: { kind: 'user', id: rig.bob.id },
        restriction: [READ, WRITE_STAGING],
        status: 'active',
        createdByUserId: rig.ada.id,
      });
      expect(outcome).toMatchObject({
        replaced: null,
        orphaned: 0,
        targetLabel: 'bob@example.com',
      });
      expect(restrictionRows()).toEqual([WRITE_STAGING, READ].sort());
      expect(await rig.adminEntries('share-created')).toMatchObject([
        {
          user_id: rig.ada.id,
          object: { type: 'share', id: outcome.share.id },
          before: null,
          after: {
            connection_id: rig.connection.id,
            target: { kind: 'user', id: rig.bob.id },
            restriction: [READ, WRITE_STAGING],
          },
        },
      ]);
    });

    it('finds the target whatever the case of the email', async () => {
      const outcome = await share({
        target: { kind: 'user', email: '  Bob@Example.COM ' },
        riskIds: [READ],
      });
      expect(outcome.share.target).toEqual({ kind: 'user', id: rig.bob.id });
    });

    it('shares to a group: every current member receives it', async () => {
      const team = await rig.root.groups.service.create(rig.operator.id, 'team');
      const outcome = await share({ target: { kind: 'group', groupId: team.id }, riskIds: [READ] });
      expect(outcome.targetLabel).toBe('group team');
      expect(await rig.root.shares.service.received(await rig.actor(rig.bob))).toEqual([]);
      await rig.root.groups.service.addMember(rig.operator.id, team.id, 'bob@example.com');
      const received = await rig.root.shares.service.received(await rig.actor(rig.bob));
      expect(received.map((r) => [r.via, r.risks.map((x) => x.risk_id)])).toEqual([
        ['group team', [READ]],
      ]);
    });

    it.each([
      ['a wildcard', ['*']],
      ['a provider wildcard', ['depot.*']],
      ['the base id of an env-scoped entry', ['depot.write']],
      ['an env the entry is not acceptable in', ['depot[dev].write']],
      ['a risk of another provider', ['github.code-read']],
      ['a preset reference', ['reader']],
    ])(
      'refuses %s and stores nothing: a restriction is explicit ids of this catalog',
      async (_n, ids) => {
        await expect(share(toBob([READ, ...ids]))).rejects.toMatchObject({
          code: 'risk-unknown',
          detail: ids.join(', '),
        });
        expect(await stored()).toEqual([]);
        expect(restrictionRows()).toEqual([]);
        expect(await rig.adminEntries('share-created')).toEqual([]);
      },
    );

    it('refuses an empty restriction rather than storing a share that authorizes nothing', async () => {
      await expect(share(toBob([]))).rejects.toMatchObject({ code: 'restriction-empty' });
      expect(await stored()).toEqual([]);
    });

    it('refuses a target nobody knows, and a share to the owner itself', async () => {
      await expect(
        share({ target: { kind: 'user', email: 'ghost@example.com' }, riskIds: [READ] }),
      ).rejects.toMatchObject({ code: 'target-unknown' });
      await expect(
        share({ target: { kind: 'user', email: '' }, riskIds: [READ] }),
      ).rejects.toMatchObject({ code: 'target-unknown' });
      await expect(
        share({ target: { kind: 'group', groupId: 'no-such-group' }, riskIds: [READ] }),
      ).rejects.toMatchObject({ code: 'target-unknown' });
      await expect(
        share({ target: { kind: 'user', email: 'ada@example.com' }, riskIds: [READ] }),
      ).rejects.toMatchObject({ code: 'target-is-owner' });
      expect(await stored()).toEqual([]);
    });

    it('refuses a user the IdP removed and an email two users carry', async () => {
      await rig.root.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'idp|bob-2',
        email: 'bob@example.com',
      });
      await expect(share(toBob([READ]))).rejects.toMatchObject({ code: 'target-ambiguous' });
      await rig.root.store.users.markRemoved(rig.operator.id);
      await expect(
        share({ target: { kind: 'user', email: 'ops@example.com' }, riskIds: [READ] }),
      ).rejects.toMatchObject({ code: 'target-unknown' });
    });

    it('replaces the restriction a target already holds: one active share per target', async () => {
      const first = await share(toBob([READ, WRITE_STAGING]));
      const second = await share(toBob([READ, PROFILE]));
      expect(second.replaced?.id).toBe(first.share.id);
      expect((await stored()).map((s) => [s.id, s.status])).toEqual([
        [first.share.id, 'revoked'],
        [second.share.id, 'active'],
      ]);
      expect(await rig.adminEntries('share-revoked')).toMatchObject([
        { object: { id: first.share.id }, after: { replaced_by: second.share.id } },
      ]);
      expect((await rig.adminEntries('share-created')).at(-1)).toMatchObject({
        before: { share_id: first.share.id, restriction: [READ, WRITE_STAGING] },
      });
      // Bob holds the new restriction only, not the union with the replaced one.
      const [context] = await rig.root.missions.service.issuanceContext(rig.bob);
      expect(context?.authority).toEqual([READ, PROFILE]);
    });

    it('refuses to share a revoked connection', async () => {
      await rig.root.connections.service.revoke(ada, rig.connection.id);
      await expect(share(toBob([READ]))).rejects.toMatchObject({ code: 'connection-revoked' });
    });

    it('refuses to share an unowned connection, even for a member who joined the emptied owner group again', async () => {
      const admins = await rig.root.groups.service.create(rig.operator.id, 'depot-admins');
      await rig.root.groups.service.addMember(rig.operator.id, admins.id, 'ada@example.com');
      await rig.root.connections.service.transfer(
        await rig.actor(rig.ada),
        rig.connection.id,
        admins.id,
      );
      await rig.root.groups.service.removeMember(rig.operator.id, admins.id, rig.ada.id);
      await rig.root.groups.service.addMember(rig.operator.id, admins.id, 'ada@example.com');
      // Ada is a member of the owner group again; the connection stays `unowned`
      // until the operator reassigns it (spec §2.3).
      expect((await rig.root.store.connections.getById(rig.connection.id))?.status).toBe('unowned');
      await expect(
        rig.root.shares.service.share(await rig.actor(rig.ada), rig.connection.id, toBob([READ])),
      ).rejects.toMatchObject({ code: 'connection-unowned', status: 409 });
      expect(await stored()).toEqual([]);
    });

    it('refuses a connection whose provider has no registered plugin', async () => {
      // A plugin removed from the build after the connection was made: simulated in the registry.
      const get = vi.spyOn(rig.root.registry, 'get').mockImplementation(() => undefined);
      try {
        await expect(share(toBob([READ]))).rejects.toMatchObject({ code: 'provider-unknown' });
      } finally {
        get.mockRestore();
      }
      expect(await stored()).toEqual([]);
    });

    it('settles a share even when its own entry cannot be written', async () => {
      const { share: granted } = await share(toBob([READ]));
      const mission = await rig.issueFor(rig.bob, [READ]);
      await rig.root.shares.service.revoke(ada, granted.id, granted.connectionId);
      expect(await rig.statusOf(mission)).toBe('orphaned');

      vi.spyOn(rig.root.store.auditWriter, 'write').mockRejectedValueOnce(new Error('audit down'));
      await expect(share(toBob([READ]))).rejects.toThrow('audit down');
      // The share is stored and the mission it grounds again has its entry.
      expect(await rig.statusOf(mission)).toBe('active');
      expect(await rig.adminEntries('share-created')).toHaveLength(1);
      expect(await rig.adminEntries('mission-restored')).toMatchObject([
        { user_id: rig.ada.id, object: { id: mission.mission.id } },
      ]);
    });
  });

  describe('revoke', () => {
    it('is terminal, audited, and idempotent', async () => {
      const { share: granted } = await share(toBob([READ]));
      const first = await rig.root.shares.service.revoke(ada, granted.id, granted.connectionId);
      expect(first).toMatchObject({
        share: { status: 'revoked' },
        targetLabel: 'bob@example.com',
        orphaned: 0,
      });
      expect(first.share.revokedAt).not.toBeNull();
      const again = await rig.root.shares.service.revoke(ada, granted.id, granted.connectionId);
      expect(again).toMatchObject({ share: { status: 'revoked' }, orphaned: 0 });
      expect(await rig.adminEntries('share-revoked')).toHaveLength(1);
      await expect(
        rig.root.shares.service.revoke(ada, 'nope', granted.connectionId),
      ).rejects.toMatchObject({ code: 'not-found' });
      // Named with another connection, a share is not there either.
      await expect(
        rig.root.shares.service.revoke(ada, granted.id, 'another-connection'),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('answers not-found for a share that is not of the connection the route names', async () => {
      const { share: granted } = await share(toBob([READ]));
      await expect(
        rig.root.shares.service.revoke(ada, granted.id, 'another-connection'),
      ).rejects.toMatchObject({ code: 'not-found' });
      expect((await stored())[0]?.status).toBe('active');
      const revoked = await rig.root.shares.service.revoke(ada, granted.id, rig.connection.id);
      expect(revoked.share.status).toBe('revoked');
    });

    it('answers like a repeat when another revocation won between the read and the write', async () => {
      const { share: granted } = await share(toBob([READ]));
      const { shares } = rig.root.store;
      const get = vi.spyOn(shares, 'get');
      // The first read still sees the share active; the other revocation lands right after.
      get.mockImplementationOnce(async (key) => {
        get.mockRestore();
        const seen = await shares.get(key);
        await shares.revoke(key);
        return seen;
      });
      const outcome = await rig.root.shares.service.revoke(ada, granted.id, granted.connectionId);
      expect(outcome).toMatchObject({ share: { status: 'revoked' }, orphaned: 0 });
      // The entry belongs to the act that revoked; this one wrote none.
      expect(await rig.adminEntries('share-revoked')).toEqual([]);
    });

    it('settles a revocation even when its own entry cannot be written', async () => {
      const { share: granted } = await share(toBob([READ]));
      const mission = await rig.issueFor(rig.bob, [READ]);
      vi.spyOn(rig.root.store.auditWriter, 'write').mockRejectedValueOnce(new Error('audit down'));
      await expect(
        rig.root.shares.service.revoke(ada, granted.id, granted.connectionId),
      ).rejects.toThrow('audit down');
      expect((await stored())[0]?.status).toBe('revoked');
      expect(await rig.adminEntries('mission-orphaned')).toMatchObject([
        { user_id: rig.ada.id, object: { id: mission.mission.id } },
      ]);
    });
  });

  describe('contextFor — the Share dialog', () => {
    it('gives the catalog as explicit ids, the groups, the active shares and the env labelling', async () => {
      const team = await rig.root.groups.service.create(rig.operator.id, 'team');
      const { share: granted } = await share(toBob([READ]));
      const revoked = await share({
        target: { kind: 'group', groupId: team.id },
        riskIds: [PURGE],
      });
      await rig.root.shares.service.revoke(ada, revoked.share.id, revoked.share.connectionId);

      const context = await rig.root.shares.service.contextFor(ada, rig.connection.id);
      expect(context.providerLabel).toBe('Depot');
      expect(context.risks.map((r) => r.risk_id)).toEqual([
        READ,
        WRITE_STAGING,
        WRITE_PROD,
        PURGE,
        PROFILE,
        'depot.uncategorized-write',
      ]);
      expect(context.groups.map((g) => g.name)).toEqual(['team']);
      expect(context.shares.map((v) => [v.share.id, v.targetLabel])).toEqual([
        [granted.id, 'bob@example.com'],
      ]);
      // The seeded spaces: app-staging, app-prod, and `scratch` (staging).
      expect(context.labelling).toEqual({
        derivesEnv: false,
        labelledEnvs: ['prod', 'staging'],
        unlabelledResources: 0,
      });
    });

    it('ignores stale resources when it reads the labelling', () => {
      expect(
        labellingOf(
          [
            { env: 'prod', staleSince: '2026-10-01T00:00:00.000Z' },
            { env: null, staleSince: '2026-10-01T00:00:00.000Z' },
            { env: 'staging', staleSince: null },
          ],
          false,
        ),
      ).toEqual({ derivesEnv: false, labelledEnvs: ['staging'], unlabelledResources: 0 });
    });
  });

  describe('received', () => {
    it('flags a risk the catalog dropped since the share was made, and skips revoked shares', async () => {
      const { share: granted } = await share(toBob([READ, PURGE]));
      // The catalog loses `depot.purge` after the fact (a plugin upgrade): simulated in the store.
      rig.root.store.db
        .prepare("UPDATE share_restrictions SET risk_id = 'depot.retired' WHERE risk_id = ?")
        .run(PURGE);
      const [received] = await rig.root.shares.service.received(await rig.actor(rig.bob));
      expect(received?.risks.map((risk) => [risk.risk_id, risk.label, risk.known])).toEqual([
        [READ, 'Read items', true],
        ['depot.retired', 'depot.retired', false],
      ]);
      expect(received?.risks.map((risk) => risk.row === null)).toEqual([false, true]);
      // A dropped risk is not part of the authority any more.
      const [context] = await rig.root.missions.service.issuanceContext(rig.bob);
      expect(context?.authority).toEqual([READ]);

      await rig.root.shares.service.revoke(ada, granted.id, granted.connectionId);
      expect(await rig.root.shares.service.received(await rig.actor(rig.bob))).toEqual([]);
    });
  });
});
