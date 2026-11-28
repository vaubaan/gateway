import { withImmediateTransaction } from '../../db.ts';
import { InvariantError, NotFoundError } from '../../errors.ts';
import { MISSION_RESOURCE_SOURCES } from '../../types.ts';
import { nowIso, type RepoContext } from '../context.ts';
import type { MissionCore } from './core.ts';
import { SET_COLUMNS, placementOf, type SetRow } from './rows.ts';
import type { AddedMissionResources, MissionsRepo, ResourceMove } from './types.ts';

export function createMissionResources(
  ctx: RepoContext,
  core: MissionCore,
): Pick<MissionsRepo, 'addResources' | 'applyResourceChanges' | 'accountsWithFutureSets'> {
  const { db } = ctx;
  const { insertResource, touch, deleteResourceStmt, missionLogs, versions, byGateway } = core;
  const setsOfAccount = db.prepare<[string, string], SetRow>(
    `SELECT ${SET_COLUMNS}
     FROM mission_resource_sets WHERE mission_id = ? AND account_id = ? ORDER BY position, id`,
  );
  const insertResourceFrom = db.prepare<[string, string, string, string, string]>(
    `INSERT INTO mission_resources (mission_id, account_id, resource_id, resource_set_id, source)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT (mission_id, resource_id) DO NOTHING`,
  );
  const resourceAccountOf = db.prepare<
    [string],
    { account_id: string; ref: string; env: string | null; hidden: number }
  >(
    `SELECT r.account_id, r.ref, COALESCE(r.env, c.default_env) AS env, r.hidden
     FROM account_resources r JOIN accounts c ON c.id = r.account_id WHERE r.id = ?`,
  );
  // Running: stored `active` and not past its expiry (an `orphaned` one is derived, still stored active).
  const runningOnAccount = db.prepare<[string, string], { id: string }>(
    `SELECT DISTINCT m.id FROM missions m JOIN mission_accounts mc ON mc.mission_id = m.id
     WHERE mc.account_id = ? AND m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > ?)
     ORDER BY m.id`,
  );
  const heldOnAccount = db.prepare<
    [string, string],
    { resource_id: string; resource_set_id: string }
  >(
    'SELECT resource_id, resource_set_id FROM mission_resources WHERE mission_id = ? AND account_id = ?',
  );
  const futureAccounts = db.prepare<[string], { account_id: string }>(
    `SELECT DISTINCT s.account_id FROM mission_resource_sets s JOIN missions m ON m.id = s.mission_id
     WHERE s.future = 1 AND m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > ?)
     ORDER BY s.account_id`,
  );

  return {
    async addResources(missionId, accountId, resourceIds, source, created, judgedSetIds) {
      if (!MISSION_RESOURCE_SOURCES.includes(source)) {
        throw new InvariantError(`unknown mission resource source '${String(source)}'`);
      }
      const now = nowIso(ctx);
      return withImmediateTransaction(db, (): AddedMissionResources => {
        const sets = setsOfAccount.all(missionId, accountId);
        if (sets.length === 0) {
          throw new NotFoundError('mission_account', `${missionId}/${accountId}`);
        }
        const judged = sets.filter((set) => judgedSetIds?.includes(set.id) ?? false);
        const candidates = judged.length > 0 ? judged : sets;
        const held = new Map(
          heldOnAccount.all(missionId, accountId).map((r) => [r.resource_id, r.resource_set_id]),
        );
        const refs: string[] = [];
        const placed: { resourceId: string; resourceSetId: string }[] = [];
        const added: string[] = [];
        for (const resourceId of resourceIds) {
          const owner = resourceAccountOf.get(resourceId);
          if (!owner) throw new NotFoundError('account_resource', resourceId);
          if (owner.account_id !== accountId) {
            throw new InvariantError(
              `resource ${resourceId} does not belong to account ${accountId}`,
            );
          }
          if (!refs.includes(owner.ref)) refs.push(owner.ref);
          const already = held.get(resourceId);
          if (already !== undefined) {
            placed.push({ resourceId, resourceSetId: already });
            continue;
          }
          const target = placementOf(candidates, owner.env);
          insertResourceFrom.run(missionId, accountId, resourceId, target.id, source);
          held.set(resourceId, target.id);
          placed.push({ resourceId, resourceSetId: target.id });
          added.push(resourceId);
        }
        if (added.length > 0) {
          touch.run(now, missionId);
          versions.recordSync(
            missionId,
            {
              cause:
                source === 'created'
                  ? 'resource-created'
                  : source === 'future'
                    ? 'resources-discovered'
                    : 'edit',
              author: byGateway,
            },
            now,
          );
        }
        // What the mission created is in its activity.
        const missionLog =
          source === 'created' && created && refs.length > 0
            ? missionLogs.missionLogOfMission(missionId)
            : null;
        if (missionLog && created) {
          missionLogs.recordEvent(
            missionLog.id,
            {
              kind: 'resources-created',
              actorUserId: created.actorUserId,
              details: { tool: created.tool, account_id: accountId, refs },
            },
            now,
          );
        }
        return { placed, added };
      });
    },
    async applyResourceChanges(accountId, changes, neverJoin) {
      const now = nowIso(ctx);
      const excluded = new Set(neverJoin);
      return withImmediateTransaction(db, (): ResourceMove[] => {
        const resources = new Map<string, { ref: string; env: string | null; hidden: boolean }>();
        for (const change of changes) {
          const row = resourceAccountOf.get(change.resourceId);
          if (row?.account_id !== accountId) continue;
          resources.set(change.resourceId, {
            ref: row.ref,
            env: row.env,
            hidden: row.hidden === 1,
          });
        }
        const moves: ResourceMove[] = [];
        for (const { id: missionId } of runningOnAccount.all(accountId, now)) {
          const sets = setsOfAccount.all(missionId, accountId);
          const held = new Map(
            heldOnAccount.all(missionId, accountId).map((r) => [r.resource_id, r.resource_set_id]),
          );
          const before = moves.length;
          for (const change of changes) {
            const resource = resources.get(change.resourceId);
            if (!resource) continue;
            const move = (resourceSetId: string, kind: ResourceMove['change']): void => {
              moves.push({
                missionId,
                accountId,
                resourceSetId,
                resourceId: change.resourceId,
                ref: resource.ref,
                change: kind,
                reason: change.reason,
              });
            };
            const holding = sets.find((set) => set.id === held.get(change.resourceId));
            if (holding) {
              // A resource that just appeared and is held already was placed by its
              // creating call (`addResources`): only a relabel moves a held resource.
              if (change.reason !== 'relabelled') continue;
              if (holding.mixed_env === 1 || holding.env === resource.env) continue;
              deleteResourceStmt.run(missionId, change.resourceId);
              held.delete(change.resourceId);
              move(holding.id, 'left');
            }
            if (resource.hidden || excluded.has(change.resourceId)) continue;
            const target =
              sets.find(
                (set) => set.future === 1 && set.mixed_env === 0 && set.env === resource.env,
              ) ?? sets.find((set) => set.future === 1 && set.mixed_env === 1);
            if (!target) continue;
            insertResource.run(missionId, accountId, change.resourceId, target.id, 'future');
            held.set(change.resourceId, target.id);
            move(target.id, 'joined');
          }
          if (moves.length > before) {
            touch.run(now, missionId);
            versions.recordSync(
              missionId,
              { cause: 'resources-discovered', author: byGateway },
              now,
            );
          }
        }
        return moves;
      });
    },
    async accountsWithFutureSets(now) {
      return futureAccounts.all(now).map((r) => r.account_id);
    },
  };
}
