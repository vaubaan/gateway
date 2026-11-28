import { NotFoundError } from '../../errors.ts';
import type {
  MissionAccountRecord,
  MissionPolicyEntry,
  MissionPolicyLineInput,
  MissionRecord,
  MissionVersionStamp,
} from '../../types.ts';
import { parseEnum, type RepoContext } from '../context.ts';
import { STORED_MISSION_STATUSES } from '../enums.ts';
import type { Statement } from 'better-sqlite3';

import { createMissionLogPrimitives, type MissionLogPrimitives } from '../mission-logs.ts';
import { createVersionPrimitives, type VersionPrimitives } from '../mission-versions.ts';
import {
  COLUMNS,
  SET_COLUMNS,
  policyToRecord,
  setToRecord,
  type AccountRow,
  type MissionRow,
  type PolicyRow,
  type SelectedRow,
  type SetRow,
} from './rows.ts';

/** The statements and helpers the parts of the missions repository share. */
export interface MissionCore {
  readonly byId: Statement<[string], MissionRow>;
  readonly insertAccount: Statement<[string, string]>;
  readonly insertSet: Statement<
    [string, string, string, number, number, string | null, string | null]
  >;
  readonly insertResource: Statement<[string, string, string, string, string]>;
  readonly setExpiry: Statement<[string | null, string, string]>;
  readonly touch: Statement<[string, string]>;
  readonly deleteResourceStmt: Statement<[string, string]>;
  readonly retireApprovalsStmt: Statement<[string, string, string, string]>;
  readonly missionLogs: MissionLogPrimitives;
  readonly versions: VersionPrimitives;
  readonly byPerson: (userId: string) => MissionVersionStamp['author'];
  readonly byGateway: MissionVersionStamp['author'];
  readonly toRecord: (row: MissionRow) => MissionRecord;
  readonly requireMission: (id: string) => MissionRecord;
  readonly writeLine: (missionId: string, setId: string, p: MissionPolicyLineInput) => void;
  readonly writePolicy: (missionId: string, policy: readonly MissionPolicyEntry[]) => void;
}

export function createMissionCore(ctx: RepoContext): MissionCore {
  const { db } = ctx;
  const byId = db.prepare<[string], MissionRow>(`SELECT ${COLUMNS} FROM missions WHERE id = ?`);
  const insertAccount = db.prepare<[string, string]>(
    'INSERT INTO mission_accounts (mission_id, account_id) VALUES (?, ?)',
  );
  const insertSet = db.prepare<
    [string, string, string, number, number, string | null, string | null]
  >(
    `INSERT INTO mission_resource_sets
       (id, mission_id, account_id, position, future, env, trust_levels_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertResource = db.prepare<[string, string, string, string, string]>(
    `INSERT INTO mission_resources (mission_id, account_id, resource_id, resource_set_id, source)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertPolicy = db.prepare<[string, string, string, number, number, number, string]>(
    `INSERT INTO mission_policy
       (mission_id, resource_set_id, risk_id, quota, rate_limit, rate_window_seconds, gate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // Risk order first, the order a policy was always read in; a risk in two sets by position.
  const policyOf = db.prepare<[string], PolicyRow>(
    `SELECT p.resource_set_id, p.risk_id, p.quota, p.rate_limit, p.rate_window_seconds, p.gate
     FROM mission_policy p JOIN mission_resource_sets s ON s.id = p.resource_set_id
     WHERE p.mission_id = ? ORDER BY p.risk_id, s.account_id, s.position`,
  );
  const accountsOf = db.prepare<[string], AccountRow>(
    'SELECT account_id FROM mission_accounts WHERE mission_id = ? ORDER BY account_id',
  );
  const setsOf = db.prepare<[string], SetRow>(
    `SELECT ${SET_COLUMNS}
     FROM mission_resource_sets WHERE mission_id = ? ORDER BY account_id, position, id`,
  );
  const resourcesOf = db.prepare<[string], SelectedRow>(
    'SELECT resource_id, resource_set_id, source FROM mission_resources WHERE mission_id = ? ORDER BY resource_id',
  );
  const setExpiry = db.prepare<[string | null, string, string]>(
    'UPDATE missions SET expires_at = ?, updated_at = ? WHERE id = ?',
  );
  const touch = db.prepare<[string, string]>('UPDATE missions SET updated_at = ? WHERE id = ?');
  const deleteResourceStmt = db.prepare<[string, string]>(
    'DELETE FROM mission_resources WHERE mission_id = ? AND resource_id = ?',
  );
  const retireApprovalsStmt = db.prepare<[string, string, string, string]>(
    `UPDATE approvals SET consumed_at = ? WHERE mission_id = ? AND consumed_at IS NULL
     AND (risk_id = ? OR EXISTS (SELECT 1 FROM json_each(approvals.risk_ids_json) WHERE value = ?))`,
  );
  // The mission log's events belong to the mission logs repository: its primitives run here,
  // inside this repository's transaction.
  const missionLogs = createMissionLogPrimitives(ctx);
  // Every write that may move the configuration ends with `versions.recordSync`: one
  // version when something moved, none otherwise (migration 0039).
  const versions = createVersionPrimitives(ctx);
  const byPerson = (userId: string): MissionVersionStamp['author'] => ({ kind: 'person', userId });
  const byGateway: MissionVersionStamp['author'] = { kind: 'gateway' };

  function toRecord(row: MissionRow): MissionRecord {
    // perf: three queries per mission (sets, resources, policy); a Postgres port joins.
    const selected = new Map<string, SelectedRow[]>();
    for (const r of resourcesOf.all(row.id)) {
      const list = selected.get(r.resource_set_id) ?? [];
      list.push(r);
      selected.set(r.resource_set_id, list);
    }
    const sets = setsOf.all(row.id);
    return {
      id: row.id,
      name: row.name,
      creatorUserId: row.creator_user_id,
      status: parseEnum(STORED_MISSION_STATUSES, row.status, 'missions.status'),
      periodAnchor: row.period_anchor,
      periodSeconds: row.period_seconds,
      expiresAt: row.expires_at,
      issuedByMissionId: row.issued_by_mission_id,
      issuedViaClientName: row.issued_via_client_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      accounts: accountsOf.all(row.id).map((c): MissionAccountRecord => ({
        accountId: c.account_id,
        resourceSets: sets
          .filter((set) => set.account_id === c.account_id)
          .map((set) => setToRecord(set, selected.get(set.id) ?? [])),
      })),
      policy: policyOf.all(row.id).map(policyToRecord),
    };
  }

  function requireMission(id: string): MissionRecord {
    const row = byId.get(id);
    if (!row) throw new NotFoundError('mission', id);
    return toRecord(row);
  }

  function writeLine(missionId: string, setId: string, p: MissionPolicyLineInput): void {
    insertPolicy.run(missionId, setId, p.riskId, p.quota, p.rateLimit, p.rateWindowSeconds, p.gate);
  }

  function writePolicy(missionId: string, policy: readonly MissionPolicyEntry[]): void {
    for (const p of policy) writeLine(missionId, p.resourceSetId, p);
  }

  return {
    byId,
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
    byGateway,
    toRecord,
    requireMission,
    writeLine,
    writePolicy,
  };
}
