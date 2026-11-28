import { withImmediateTransaction } from '../../db.ts';
import { InvariantError } from '../../errors.ts';
import type { MissionPolicyEntry, NewEvent, RequestLine, RiskId } from '../../types.ts';
import { nowIso, parseEnum, type RepoContext } from '../context.ts';
import { GATES } from '../enums.ts';
import { riskIdsOf } from '../approvals.ts';
import { requestLinesOf, storedLinesOf } from '../requests.ts';
import type { MissionCore } from './core.ts';
import { lineKey, setIdsOf } from './rows.ts';
import type { AppliedLimitChange, MissionsRepo } from './types.ts';
import { validateFlatPolicy } from './validation.ts';

export function createMissionPolicy(
  ctx: RepoContext,
  core: MissionCore,
): Pick<
  MissionsRepo,
  | 'replacePolicy'
  | 'changePermissions'
  | 'setGate'
  | 'setLimits'
  | 'trustMarks'
  | 'snoozeTrustRaise'
> {
  const { db } = ctx;
  const {
    touch,
    retireApprovalsStmt,
    missionLogs,
    versions,
    byPerson,
    byGateway,
    requireMission,
    writePolicy,
  } = core;
  const deletePolicy = db.prepare<[string]>('DELETE FROM mission_policy WHERE mission_id = ?');
  const setsOfRisk = db.prepare<[string, string], { resource_set_id: string }>(
    'SELECT resource_set_id FROM mission_policy WHERE mission_id = ? AND risk_id = ?',
  );
  const lineOf = db.prepare<
    [string, string, string],
    { quota: number; rate_limit: number; rate_window_seconds: number; gate: string }
  >(
    `SELECT quota, rate_limit, rate_window_seconds, gate FROM mission_policy
     WHERE mission_id = ? AND resource_set_id = ? AND risk_id = ?`,
  );
  const setGateStmt = db.prepare<[string, string, string]>(
    'UPDATE mission_policy SET gate = ? WHERE resource_set_id = ? AND risk_id = ?',
  );
  const setLimitsStmt = db.prepare<[number, number, string, string]>(
    'UPDATE mission_policy SET quota = ?, rate_limit = ? WHERE resource_set_id = ? AND risk_id = ?',
  );
  const snoozeStmt = db.prepare<[string, string, string, string, string, string]>(
    `INSERT INTO mission_trust_marks (mission_id, resource_set_id, macro_action_id, snoozed_at)
     SELECT ?, ?, ?, ? FROM mission_resource_sets WHERE id = ? AND mission_id = ?
     ON CONFLICT (resource_set_id, macro_action_id) DO UPDATE SET snoozed_at = excluded.snoozed_at`,
  );
  const trustMarksOf = db.prepare<
    [string],
    {
      resource_set_id: string;
      macro_action_id: string;
      level_changed_at: string | null;
      snoozed_at: string | null;
    }
  >(
    `SELECT resource_set_id, macro_action_id, level_changed_at, snoozed_at
     FROM mission_trust_marks WHERE mission_id = ? ORDER BY resource_set_id, macro_action_id`,
  );

  /** The set a line names: given, or the one set of the mission that accepts the risk. */
  function lineOfInput(
    missionId: string,
    line: RiskId | { readonly resourceSetId?: string; readonly riskId: RiskId },
  ): RequestLine | null {
    if (typeof line !== 'string' && line.resourceSetId !== undefined) {
      return { resourceSetId: line.resourceSetId, riskId: line.riskId };
    }
    const riskId = typeof line === 'string' ? line : line.riskId;
    const sets = setsOfRisk.all(missionId, riskId);
    const [only] = sets;
    return sets.length === 1 && only ? { resourceSetId: only.resource_set_id, riskId } : null;
  }

  return {
    async replacePolicy(id, policy) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const mission = requireMission(id);
        validateFlatPolicy(ctx, policy, setIdsOf(mission));
        deletePolicy.run(id);
        writePolicy(id, policy);
        touch.run(now, id);
        versions.recordSync(id, { cause: 'edit', author: byGateway }, now);
        return requireMission(id);
      });
    },
    async changePermissions(id, policy, expected, actor, requestId) {
      const key = (lines: readonly MissionPolicyEntry[]) =>
        JSON.stringify(
          [...lines]
            .sort((a, b) => lineKey(a).localeCompare(lineKey(b)))
            .map((p) => [
              p.resourceSetId,
              p.riskId,
              p.quota,
              p.rateLimit,
              p.rateWindowSeconds,
              p.gate,
            ]),
        );
      return withImmediateTransaction(db, () => {
        const mission = requireMission(id);
        validateFlatPolicy(ctx, policy, setIdsOf(mission));
        if (
          mission.creatorUserId !== actor ||
          mission.status === 'revoked' ||
          key(mission.policy) !== key(expected)
        )
          return null;
        const now = nowIso(ctx);
        if (requestId) {
          const request = db.prepare<
            [string, string, string],
            { risk_id: string; risk_ids_json: string | null }
          >(
            `SELECT risk_id, risk_ids_json FROM requests
             WHERE id = ? AND mission_id = ? AND kind = 'permission' AND state = 'open' AND expires_at > ?`,
          );
          const row = request.get(requestId, id, now);
          if (!row) return null;
          const asked = requestLinesOf(
            riskIdsOf(row.risk_id, row.risk_ids_json),
            storedLinesOf(ctx, requestId),
          );
          const granted = new Set(policy.map(lineKey));
          if (asked.length === 0 || !asked.every((line) => granted.has(lineKey(line)))) return null;
        }
        const kept = new Set(policy.map(lineKey));
        const removed = mission.policy.filter((p) => !kept.has(lineKey(p)));
        deletePolicy.run(id);
        writePolicy(id, policy);
        touch.run(now, id);
        versions.recordSync(
          id,
          { cause: requestId ? 'permission-request' : 'edit', author: byPerson(actor) },
          now,
        );
        const missionLog = missionLogs.missionLogOfMission(id);
        if (missionLog) {
          for (const p of removed)
            missionLogs.recordEvent(
              missionLog.id,
              {
                kind: 'gate-changed',
                riskId: p.riskId,
                resourceSetId: p.resourceSetId,
                actorUserId: actor,
                details: { gate: 'approval', gate_before: p.gate },
              },
              now,
            );
          missionLogs.recordEvent(
            missionLog.id,
            {
              kind: 'permissions-changed',
              actorUserId: actor,
              details: { before: mission.policy, after: policy, request_id: requestId ?? null },
            },
            now,
          );
        }
        // An unconsumed approval must not survive removal and re-addition of its risk.
        for (const p of removed) retireApprovalsStmt.run(now, id, p.riskId, p.riskId);
        if (requestId)
          db.prepare(
            `UPDATE requests SET state = 'granted', decided_at = ?, decided_by_user_id = ?,
          decision_json = ?, args_blob = NULL, key_version = NULL WHERE id = ?`,
          ).run(now, actor, JSON.stringify({ resolution: 'add-permissions' }), requestId);
        return requireMission(id);
      });
    },
    async setGate(id, line, gate, actorUserId, options = {}) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const mission = requireMission(id);
        const target = lineOfInput(id, line);
        if (!target) return null;
        const row = lineOf.get(id, target.resourceSetId, target.riskId);
        if (!row) return null;
        const previous = parseEnum(GATES, row.gate, 'mission_policy.gate');
        const closing = previous === gate && gate === 'approval' && options.closeOpening === true;
        if (previous === gate && !closing) return { mission, previous, openingClosed: false };
        if (!closing) {
          setGateStmt.run(gate, target.resourceSetId, target.riskId);
          versions.recordSync(id, { cause: 'edit', author: byPerson(actorUserId) }, now);
        }
        touch.run(now, id);
        const missionLog = missionLogs.missionLogOfMission(id);
        if (missionLog) {
          missionLogs.recordEvent(
            missionLog.id,
            {
              kind: 'gate-changed',
              riskId: target.riskId,
              resourceSetId: target.resourceSetId,
              actorUserId,
              details: { gate, gate_before: previous },
            } satisfies NewEvent,
            now,
          );
        }
        return {
          mission: requireMission(id),
          previous,
          openingClosed: closing && missionLog !== null,
        };
      });
    },
    async setLimits(id, changes, actorUserId) {
      for (const change of changes) {
        if (!Number.isInteger(change.quota) || change.quota < 0) {
          throw new InvariantError(`quota must be a non-negative integer (${change.riskId})`);
        }
        if (!Number.isInteger(change.rateLimit) || change.rateLimit < 0) {
          throw new InvariantError(`rate limit must be a non-negative integer (${change.riskId})`);
        }
      }
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        requireMission(id);
        const applied: AppliedLimitChange[] = [];
        const seen = new Set<string>();
        for (const change of changes) {
          const target = lineOfInput(id, change);
          if (!target) return null;
          if (seen.has(lineKey(target))) throw new InvariantError('duplicate line in limits');
          seen.add(lineKey(target));
          const row = lineOf.get(id, target.resourceSetId, target.riskId);
          if (!row) return null;
          const moved = row.quota !== change.quota || row.rate_limit !== change.rateLimit;
          applied.push({
            resourceSetId: target.resourceSetId,
            riskId: target.riskId,
            before: { quota: row.quota, rateLimit: row.rate_limit },
            after: { quota: change.quota, rateLimit: change.rateLimit },
            rateWindowSeconds: row.rate_window_seconds,
            changed: moved,
          });
        }
        const moved = applied.filter((a) => a.changed);
        if (moved.length === 0) return { mission: requireMission(id), changes: applied };
        for (const a of moved) {
          setLimitsStmt.run(a.after.quota, a.after.rateLimit, a.resourceSetId, a.riskId);
        }
        touch.run(now, id);
        versions.recordSync(id, { cause: 'edit', author: byPerson(actorUserId) }, now);
        const missionLog = missionLogs.missionLogOfMission(id);
        if (missionLog) {
          for (const a of moved) {
            missionLogs.recordEvent(
              missionLog.id,
              {
                kind: 'limits-changed',
                riskId: a.riskId,
                resourceSetId: a.resourceSetId,
                actorUserId,
                details: {
                  quota: a.after.quota,
                  quota_before: a.before.quota,
                  rate_limit_max: a.after.rateLimit,
                  rate_limit_max_before: a.before.rateLimit,
                },
              } satisfies NewEvent,
              now,
            );
          }
        }
        return { mission: requireMission(id), changes: applied };
      });
    },
    async trustMarks(missionId) {
      return trustMarksOf.all(missionId).map((row) => ({
        resourceSetId: row.resource_set_id,
        macroActionId: row.macro_action_id,
        levelChangedAt: row.level_changed_at,
        snoozedAt: row.snoozed_at,
      }));
    },
    async snoozeTrustRaise(missionId, resourceSetId, macroActionId) {
      if (macroActionId === '') return false;
      const now = nowIso(ctx);
      const { changes } = snoozeStmt.run(
        missionId,
        resourceSetId,
        macroActionId,
        now,
        resourceSetId,
        missionId,
      );
      return changes > 0;
    },
  };
}
