import { withImmediateTransaction } from '../../db.ts';
import type {
  Gate,
  Iso,
  MissionPolicyEntry,
  MissionPolicyLineInput,
  MissionResourceSetRecord,
  NewEvent,
} from '../../types.ts';
import { nowIso, type RepoContext } from '../context.ts';
import { riskIdsOf } from '../approvals.ts';
import { requestLinesOf, storedLinesOf } from '../requests.ts';
import type { MissionCore } from './core.ts';
import { lineKey, trustLevelsJsonOf } from './rows.ts';
import type { MissionsRepo } from './types.ts';
import {
  assertAccountSelections,
  resolveAccountInputs,
  validateSets,
  type CheckedAccountInput,
  type CheckedSetInput,
} from './validation.ts';

export function createMissionEdit(ctx: RepoContext, core: MissionCore): Pick<MissionsRepo, 'edit'> {
  const { db } = ctx;
  const {
    insertAccount,
    insertSet,
    insertResource,
    setExpiry,
    touch,
    deleteResourceStmt,
    retireApprovalsStmt,
    missionLogs,
    versions,
    byPerson,
    requireMission,
    writeLine,
  } = core;
  const renameStmt = db.prepare<[string, string]>('UPDATE missions SET name = ? WHERE id = ?');
  // Every expression of an UPDATE reads the row as it was: `closed_at` sees the old status.
  const reviveStmt = db.prepare<[string | null, string]>(
    `UPDATE missions SET expires_at = ?,
       status = CASE WHEN status = 'expired' THEN 'active' ELSE status END,
       closed_at = CASE WHEN status = 'expired' THEN NULL ELSE closed_at END
     WHERE id = ?`,
  );
  // An edit judged the set whole: a legacy mixed set is one environment again.
  const updateSetStmt = db.prepare<[number, number, string | null, string | null, string]>(
    `UPDATE mission_resource_sets SET position = ?, future = ?, env = ?, mixed_env = 0,
       trust_levels_json = ? WHERE id = ?`,
  );
  const deleteSetStmt = db.prepare<[string]>('DELETE FROM mission_resource_sets WHERE id = ?');
  // A trust level an edit changes restarts the count of its raise proposal (§4.7).
  const levelChangedStmt = db.prepare<[string, string, string, string]>(
    `INSERT INTO mission_trust_marks (mission_id, resource_set_id, macro_action_id, level_changed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (resource_set_id, macro_action_id) DO UPDATE SET level_changed_at = excluded.level_changed_at`,
  );
  const deleteAccountStmt = db.prepare<[string, string]>(
    'DELETE FROM mission_accounts WHERE mission_id = ? AND account_id = ?',
  );
  const moveResourceStmt = db.prepare<[string, string, string]>(
    'UPDATE mission_resources SET resource_set_id = ? WHERE mission_id = ? AND resource_id = ?',
  );
  const deleteLineStmt = db.prepare<[string, string]>(
    'DELETE FROM mission_policy WHERE resource_set_id = ? AND risk_id = ?',
  );
  const updateLineStmt = db.prepare<[number, number, number, string, string, string]>(
    `UPDATE mission_policy SET quota = ?, rate_limit = ?, rate_window_seconds = ?, gate = ?
     WHERE resource_set_id = ? AND risk_id = ?`,
  );
  const openRequestsStmt = db.prepare<
    [string],
    { id: string; kind: string; risk_id: string; risk_ids_json: string | null }
  >(
    `SELECT id, kind, risk_id, risk_ids_json FROM requests
     WHERE mission_id = ? AND state = 'open' AND kind IN ('claim', 'approval')`,
  );
  const closeRequestStmt = db.prepare<[string, string, string, string]>(
    `UPDATE requests SET state = 'refused', decided_at = ?, decided_by_user_id = ?,
       decision_json = ?, args_blob = NULL, key_version = NULL
     WHERE id = ? AND state = 'open'`,
  );

  function sameLimits(a: MissionPolicyLineInput, b: MissionPolicyLineInput): boolean {
    return (
      a.quota === b.quota &&
      a.rateLimit === b.rateLimit &&
      a.rateWindowSeconds === b.rateWindowSeconds
    );
  }

  /** The limits and gate of a line, as an event names them. */
  function lineDetails(p: MissionPolicyLineInput): {
    quota: number;
    rate_limit_max: number;
    rate_window_seconds: number;
    gate: Gate;
  } {
    return {
      quota: p.quota,
      rate_limit_max: p.rateLimit,
      rate_window_seconds: p.rateWindowSeconds,
      gate: p.gate,
    };
  }

  /** The open claims and approval requests about a removed line, closed. In-transaction. */
  function closeMootRequests(
    missionId: string,
    gone: ReadonlySet<string>,
    actorUserId: string,
    now: Iso,
    record: (event: NewEvent) => void,
  ): { id: string; kind: string }[] {
    const closed: { id: string; kind: string }[] = [];
    if (gone.size === 0) return closed;
    for (const row of openRequestsStmt.all(missionId)) {
      const lines = requestLinesOf(
        riskIdsOf(row.risk_id, row.risk_ids_json),
        storedLinesOf(ctx, row.id),
      );
      const moot = [...new Set(lines.filter((l) => gone.has(lineKey(l))).map((l) => l.riskId))];
      if (moot.length === 0) continue;
      const decision = JSON.stringify({ resolution: 'mission-changed', removed: moot });
      if (closeRequestStmt.run(now, actorUserId, decision, row.id).changes === 0) continue;
      closed.push({ id: row.id, kind: row.kind });
      record({
        kind: 'request',
        riskId: row.risk_id,
        resourceSetId: lines[0]?.resourceSetId ?? null,
        details: {
          request_id: row.id,
          request_kind: row.kind === 'claim' ? 'claim' : 'approval',
          state: 'refused',
          reason: 'mission-changed',
        },
      });
    }
    return closed;
  }

  /** A set of a write, with the id it is stored under. */
  interface PlannedSet {
    readonly id: string;
    readonly kept: boolean;
    readonly position: number;
    readonly accountId: string;
    readonly input: CheckedSetInput;
  }

  return {
    async edit(id, raw) {
      const unchecked = resolveAccountInputs(ctx, raw.accounts, raw.policy);
      validateSets(ctx, unchecked);
      const resolved = assertAccountSelections(ctx, unchecked);
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const before = requireMission(id);
        // An account given flat keeps its one stored set.
        const input = {
          ...raw,
          accounts: resolved.map((c, i): CheckedAccountInput => {
            const given = raw.accounts[i];
            const flat = given !== undefined && !('resourceSets' in given);
            const stored = before.accounts.find((b) => b.accountId === c.accountId);
            const [only] = stored?.resourceSets ?? [];
            const [set] = c.resourceSets;
            return flat && only && set && stored?.resourceSets.length === 1
              ? { ...c, resourceSets: [{ ...set, id: only.id }] }
              : c;
          }),
        };
        if (
          before.creatorUserId !== input.actorUserId ||
          before.status === 'revoked' ||
          !input.unchanged(before)
        ) {
          return null;
        }
        if (before.name !== input.name) renameStmt.run(input.name, id);
        if (before.expiresAt !== input.expiresAt) {
          // An end moved into the future, or removed, brings an expired mission back.
          if (input.expiresAt === null || input.expiresAt > now)
            reviveStmt.run(input.expiresAt, id);
          else setExpiry.run(input.expiresAt, now, id);
        }

        // ── Which set is which: a stored id on the same account keeps its set. ──
        const stored = new Map<string, { accountId: string; set: MissionResourceSetRecord }>();
        for (const c of before.accounts) {
          for (const set of c.resourceSets) stored.set(set.id, { accountId: c.accountId, set });
        }
        const planned: PlannedSet[] = input.accounts.flatMap((c) =>
          c.resourceSets.map((set, index): PlannedSet => {
            const kept = set.id !== undefined && stored.get(set.id)?.accountId === c.accountId;
            return {
              id: kept && set.id !== undefined ? set.id : ctx.newId(),
              kept,
              position: index + 1,
              accountId: c.accountId,
              input: set,
            };
          }),
        );
        const keptIds = new Set(planned.filter((p) => p.kept).map((p) => p.id));
        const nextAccounts = new Set(input.accounts.map((c) => c.accountId));

        const missionLog = missionLogs.missionLogOfMission(id);
        const record = (event: NewEvent): void => {
          if (missionLog) missionLogs.recordEvent(missionLog.id, event, now);
        };
        const actorUserId = input.actorUserId;

        // ── The lines removed go first, while their sets still exist. ──
        const linesBefore = new Map(before.policy.map((p) => [lineKey(p), p]));
        const linesAfter = new Map<string, MissionPolicyEntry>();
        for (const set of planned) {
          for (const line of set.input.policy) {
            const entry: MissionPolicyEntry = { ...line, resourceSetId: set.id };
            linesAfter.set(lineKey(entry), entry);
          }
        }
        const removed = before.policy.filter((p) => !linesAfter.has(lineKey(p)));
        for (const p of removed) {
          deleteLineStmt.run(p.resourceSetId, p.riskId);
          // An approval must not survive the removal and re-addition of its risk.
          retireApprovalsStmt.run(now, id, p.riskId, p.riskId);
          record({
            kind: 'permission-removed',
            riskId: p.riskId,
            resourceSetId: p.resourceSetId,
            actorUserId,
            details: lineDetails(p),
          });
        }

        // ── The sets and their resources. Order matters: a resource row always names a
        // set that exists.
        const removedSets = [...stored.entries()].filter(([setId]) => !keptIds.has(setId));
        for (const c of input.accounts) {
          if (!before.accounts.some((b) => b.accountId === c.accountId)) {
            insertAccount.run(id, c.accountId);
          }
        }
        for (const set of planned) {
          if (set.kept) continue;
          insertSet.run(
            set.id,
            id,
            set.accountId,
            set.position,
            set.input.future ? 1 : 0,
            set.input.env,
            trustLevelsJsonOf(set.input),
          );
        }
        for (const c of before.accounts) {
          if (nextAccounts.has(c.accountId)) continue;
          // Its sets, resources and lines go with it (foreign keys, ON DELETE CASCADE).
          deleteAccountStmt.run(id, c.accountId);
        }
        const placedBefore = new Map<string, string>();
        for (const c of before.accounts) {
          if (!nextAccounts.has(c.accountId)) continue;
          for (const set of c.resourceSets) {
            for (const resourceId of set.resourceIds) placedBefore.set(resourceId, set.id);
          }
        }
        const placedAfter = new Map<string, PlannedSet>();
        for (const set of planned) {
          for (const resourceId of set.input.resourceIds) placedAfter.set(resourceId, set);
        }
        for (const [resourceId] of placedBefore) {
          if (!placedAfter.has(resourceId)) deleteResourceStmt.run(id, resourceId);
        }
        for (const [resourceId, set] of placedAfter) {
          const was = placedBefore.get(resourceId);
          if (was === undefined) insertResource.run(id, set.accountId, resourceId, set.id, 'edit');
          else if (was !== set.id) moveResourceStmt.run(set.id, id, resourceId);
        }
        for (const [setId, { accountId }] of removedSets) {
          if (nextAccounts.has(accountId)) deleteSetStmt.run(setId);
        }
        for (const set of planned) {
          if (!set.kept) continue;
          const was = stored.get(set.id)?.set;
          const trustLevels = trustLevelsJsonOf(set.input);
          if (
            !was ||
            was.position !== set.position ||
            was.future !== set.input.future ||
            was.env !== set.input.env ||
            was.mixedEnv ||
            trustLevelsJsonOf(was) !== trustLevels
          ) {
            updateSetStmt.run(
              set.position,
              set.input.future ? 1 : 0,
              set.input.env,
              trustLevels,
              set.id,
            );
          }
          if (was) {
            const before = was.trustLevels ?? {};
            const after = set.input.trustLevels ?? {};
            for (const macroActionId of new Set([...Object.keys(before), ...Object.keys(after)])) {
              if (before[macroActionId] !== after[macroActionId]) {
                levelChangedStmt.run(id, set.id, macroActionId, now);
              }
            }
          }
        }

        // ── The lines added or changed. ──
        for (const [key, p] of linesAfter) {
          const old = linesBefore.get(key);
          if (!old) {
            writeLine(id, p.resourceSetId, p);
            record({
              kind: 'permission-added',
              riskId: p.riskId,
              resourceSetId: p.resourceSetId,
              actorUserId,
              details: lineDetails(p),
            });
            continue;
          }
          const limitsMove = !sameLimits(old, p);
          if (!limitsMove && old.gate === p.gate) continue;
          updateLineStmt.run(
            p.quota,
            p.rateLimit,
            p.rateWindowSeconds,
            p.gate,
            p.resourceSetId,
            p.riskId,
          );
          if (limitsMove) {
            const windowMoves = old.rateWindowSeconds !== p.rateWindowSeconds;
            record({
              kind: 'limits-changed',
              riskId: p.riskId,
              resourceSetId: p.resourceSetId,
              actorUserId,
              details: {
                quota: p.quota,
                quota_before: old.quota,
                rate_limit_max: p.rateLimit,
                rate_limit_max_before: old.rateLimit,
                ...(windowMoves
                  ? {
                      rate_window_seconds: p.rateWindowSeconds,
                      rate_window_seconds_before: old.rateWindowSeconds,
                    }
                  : {}),
              },
            });
          }
          if (old.gate !== p.gate) {
            record({
              kind: 'gate-changed',
              riskId: p.riskId,
              resourceSetId: p.resourceSetId,
              actorUserId,
              details: { gate: p.gate, gate_before: old.gate },
            });
          }
        }
        const gone = new Set(removed.map(lineKey));
        const closed = closeMootRequests(id, gone, actorUserId, now, record);
        touch.run(now, id);
        record(input.summary(closed.length));
        versions.recordSync(
          id,
          input.restoredFrom === undefined
            ? {
                cause: 'edit',
                author:
                  input.viaMissionId !== undefined
                    ? { kind: 'mission', missionId: input.viaMissionId, userId: actorUserId }
                    : byPerson(actorUserId),
              }
            : {
                cause: 'rollback',
                author: byPerson(actorUserId),
                restoredFrom: input.restoredFrom,
              },
          now,
        );
        return { before, mission: requireMission(id), closedRequests: closed };
      });
    },
  };
}
