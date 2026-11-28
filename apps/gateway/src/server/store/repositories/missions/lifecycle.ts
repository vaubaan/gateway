import { withImmediateTransaction } from '../../db.ts';
import { NotFoundError } from '../../errors.ts';
import type { MissionIssuerRecord } from '../../types.ts';
import { nowIso, type RepoContext } from '../context.ts';
import { missionScopePiece } from '../audit.ts';
import type { MissionCore } from './core.ts';
import { COLUMNS, trustLevelsJsonOf, type IssuerRow, type MissionRow } from './rows.ts';
import type { MissionsRepo } from './types.ts';
import {
  assertAccountSelections,
  resolveAccountInputs,
  validateSets,
  type CheckedAccountInput,
} from './validation.ts';

export function createMissionLifecycle(
  ctx: RepoContext,
  core: MissionCore,
): Pick<
  MissionsRepo,
  | 'create'
  | 'issuersOf'
  | 'getById'
  | 'countActive'
  | 'listForCreator'
  | 'listForMember'
  | 'listForAccount'
  | 'listInScope'
  | 'setStatus'
  | 'setExpiresAt'
> {
  const { db } = ctx;
  const {
    byId,
    insertAccount,
    insertSet,
    insertResource,
    setExpiry,
    versions,
    byPerson,
    byGateway,
    toRecord,
    requireMission,
    writeLine,
  } = core;
  const activeCount = db.prepare<[string], { readonly n: number }>(
    `SELECT COUNT(*) AS n FROM missions
      WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)`,
  );
  const byCreator = db.prepare<[string], MissionRow>(
    `SELECT ${COLUMNS} FROM missions WHERE creator_user_id = ? ORDER BY created_at`,
  );
  const byMember = db.prepare<[string], MissionRow>(
    `SELECT m.id, m.name, m.creator_user_id, m.status, m.period_anchor, m.period_seconds,
       m.expires_at, m.issued_by_mission_id, m.issued_via_client_name, m.created_at,
       m.updated_at, m.closed_at
     FROM missions m JOIN mission_members mm ON mm.mission_id = m.id
     WHERE mm.user_id = ? AND mm.removed_at IS NULL ORDER BY m.created_at`,
  );
  const byAccount = db.prepare<[string], MissionRow>(
    `SELECT m.id, m.name, m.creator_user_id, m.status, m.period_anchor, m.period_seconds,
       m.expires_at, m.issued_by_mission_id, m.issued_via_client_name, m.created_at,
       m.updated_at, m.closed_at
     FROM missions m JOIN mission_accounts mc ON mc.mission_id = m.id
     WHERE mc.account_id = ? ORDER BY m.created_at`,
  );
  const insert = db.prepare<
    [string, string, string, string, number | null, string | null, string | null, string, string]
  >(
    `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, period_seconds,
       expires_at, issued_by_mission_id, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  );
  const setStatusStmt = db.prepare<[string, string | null, string, string]>(
    'UPDATE missions SET status = ?, closed_at = COALESCE(?, closed_at), updated_at = ? WHERE id = ?',
  );

  /** Inserts one account with its sets, resources and lines. In-transaction. */
  function insertAccountWithSets(missionId: string, c: CheckedAccountInput): void {
    insertAccount.run(missionId, c.accountId);
    c.resourceSets.forEach((set, index) => {
      const setId = ctx.newId();
      insertSet.run(
        setId,
        missionId,
        c.accountId,
        index + 1,
        set.future ? 1 : 0,
        set.env,
        trustLevelsJsonOf(set),
      );
      for (const resourceId of set.resourceIds) {
        insertResource.run(missionId, c.accountId, resourceId, setId, 'issuance');
      }
      for (const line of set.policy) writeLine(missionId, setId, line);
    });
  }

  return {
    async issuersOf(missionIds) {
      const issuers = new Map<string, MissionIssuerRecord>();
      const ids = [...new Set(missionIds)];
      if (ids.length === 0) return issuers;
      const rows = db
        .prepare<string[], IssuerRow>(
          `SELECT m.id AS mission_id, m.issued_by_mission_id, i.name AS issuer_name,
                  m.issued_via_client_name
           FROM missions m LEFT JOIN missions i ON i.id = m.issued_by_mission_id
           WHERE m.id IN (${ids.map(() => '?').join(', ')})
             AND (m.issued_by_mission_id IS NOT NULL OR m.issued_via_client_name IS NOT NULL)`,
        )
        .all(...ids);
      for (const row of rows) {
        issuers.set(row.mission_id, {
          missionId: row.mission_id,
          issuedByMissionId: row.issued_by_mission_id,
          issuedByMissionName: row.issuer_name,
          clientName: row.issued_via_client_name,
        });
      }
      return issuers;
    },
    async create(input) {
      const unchecked = resolveAccountInputs(ctx, input.accounts, input.policy);
      validateSets(ctx, unchecked);
      const accounts = assertAccountSelections(ctx, unchecked);
      const id = ctx.newId();
      const now = nowIso(ctx);
      withImmediateTransaction(db, () => {
        insert.run(
          id,
          input.name,
          input.creatorUserId,
          input.periodAnchor ?? now,
          input.periodSeconds,
          input.expiresAt ?? null,
          input.issuedByMissionId ?? null,
          now,
          now,
        );
        for (const c of accounts) insertAccountWithSets(id, c);
        // Version 1: by the person, or by the mission whose agent issued it for them.
        versions.recordSync(
          id,
          {
            cause: 'issued',
            author: input.issuedByMissionId
              ? {
                  kind: 'mission',
                  missionId: input.issuedByMissionId,
                  userId: input.creatorUserId,
                }
              : byPerson(input.creatorUserId),
          },
          now,
        );
      });
      return requireMission(id);
    },
    async getById(id) {
      const row = byId.get(id);
      return row ? toRecord(row) : null;
    },
    async countActive(now) {
      return activeCount.get(now)?.n ?? 0;
    },
    async listForCreator(userId) {
      return byCreator.all(userId).map(toRecord);
    },
    async listForMember(userId) {
      return byMember.all(userId).map(toRecord);
    },
    async listForAccount(accountId) {
      return byAccount.all(accountId).map(toRecord);
    },
    async listInScope(scope, calledSince) {
      const scoped = missionScopePiece('id', scope);
      return db
        .prepare<string[], MissionRow>(
          `SELECT ${COLUMNS} FROM missions
           WHERE ${scoped.sql}
             AND (status = 'active'
                  OR id IN (SELECT mission_id FROM audit WHERE kind = 'call' AND ts >= ?))
           ORDER BY created_at`,
        )
        .all(...scoped.params, calledSince)
        .map(toRecord);
    },
    async setStatus(id, status) {
      const now = nowIso(ctx);
      const terminal = status === 'revoked' || status === 'expired';
      const result = setStatusStmt.run(status, terminal ? now : null, now, id);
      if (result.changes === 0) throw new NotFoundError('mission', id);
      return requireMission(id);
    },
    async setExpiresAt(id, expiresAt) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const result = setExpiry.run(expiresAt, now, id);
        if (result.changes === 0) throw new NotFoundError('mission', id);
        versions.recordSync(id, { cause: 'edit', author: byGateway }, now);
        return requireMission(id);
      });
    },
  };
}
