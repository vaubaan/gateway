/**
 * The versions of a mission's configuration (migration 0039, spec §4.2 "History").
 *
 * One writer: `createVersionPrimitives(ctx).recordSync`, called at the end of every
 * transaction that may change a mission's configuration — issuance, edit, permission
 * request granted, created resource placed, future resources joining or leaving, gate
 * and limits, a claim's new end, a rollback. It reads the configuration as the
 * transaction left it and appends a version when it differs from the latest one, so a
 * write that moved nothing leaves no version and one that moved something leaves exactly
 * one. Versions are never updated, and deleted only with their mission (triggers of
 * 0039): the audit's retention never reaches them.
 */
import type { MissionChangedEventDetails } from '@vaubaan/shared';

import { InvariantError } from '../errors.ts';
import {
  MISSION_VERSION_AUTHOR_KINDS,
  MISSION_VERSION_CAUSES,
  sameConfig,
  versionChanges,
  type MissionVersionAccount,
  type MissionVersionConfig,
  type MissionVersionLine,
  type MissionVersionSet,
} from '../../../lib/missions/versions.ts';
import type {
  Iso,
  MissionVersionAuthor,
  MissionVersionRecord,
  MissionVersionStamp,
} from '../types.ts';
import { parseEnum, parseJsonObject, type RepoContext } from './context.ts';
import { GATES } from './enums.ts';

export interface MissionVersionsRepo {
  /** Every version of the mission, newest first. */
  list(missionId: string): Promise<MissionVersionRecord[]>;
  /** One version; `null` when the mission has no such number. */
  get(missionId: string, number: number): Promise<MissionVersionRecord | null>;
}

export interface VersionPrimitives {
  /**
   * Appends the mission's configuration as it stands now as its next version, unless it
   * is the latest version's. Returns the number written, `null` when nothing moved.
   * In-transaction: the caller's `BEGIN IMMEDIATE` makes read and append one.
   */
  recordSync(missionId: string, stamp: MissionVersionStamp, now: Iso): number | null;
}

interface VersionRow {
  mission_id: string;
  number: number;
  created_at: string;
  cause: string;
  author_kind: string;
  author_user_id: string | null;
  author_mission_id: string | null;
  restored_from: number | null;
  config_json: string;
  changes_json: string | null;
}

const COLUMNS = `mission_id, number, created_at, cause, author_kind, author_user_id,
  author_mission_id, restored_from, config_json, changes_json`;

function authorOf(row: VersionRow): MissionVersionAuthor {
  const kind = parseEnum(
    MISSION_VERSION_AUTHOR_KINDS,
    row.author_kind,
    'mission_versions.author_kind',
  );
  if (kind === 'person') {
    if (row.author_user_id === null) {
      throw new InvariantError('mission_versions: a person author without a user');
    }
    return { kind, userId: row.author_user_id };
  }
  if (kind === 'mission') {
    if (row.author_mission_id === null) {
      throw new InvariantError('mission_versions: a mission author without a mission');
    }
    return { kind, missionId: row.author_mission_id, userId: row.author_user_id };
  }
  return { kind };
}

/** `config_json` as written by `recordSync` or migration 0039; its shape is checked at the top. */
function configOf(json: string): MissionVersionConfig {
  const value = parseJsonObject(json, 'mission_versions.config_json');
  if (
    value === null ||
    typeof value.name !== 'string' ||
    !Array.isArray(value.accounts) ||
    !Array.isArray(value.policy) ||
    typeof value.period !== 'object'
  ) {
    throw new InvariantError('mission_versions.config_json: not a configuration');
  }
  return value as unknown as MissionVersionConfig;
}

function toRecord(row: VersionRow): MissionVersionRecord {
  return {
    missionId: row.mission_id,
    number: row.number,
    createdAt: row.created_at,
    cause: parseEnum(MISSION_VERSION_CAUSES, row.cause, 'mission_versions.cause'),
    author: authorOf(row),
    restoredFrom: row.restored_from,
    config: configOf(row.config_json),
    changes:
      row.changes_json === null
        ? null
        : (parseJsonObject(
            row.changes_json,
            'mission_versions.changes_json',
          ) as unknown as MissionChangedEventDetails),
  };
}

export function createMissionVersionsRepo(ctx: RepoContext): MissionVersionsRepo {
  const listOf = ctx.db.prepare<[string], VersionRow>(
    `SELECT ${COLUMNS} FROM mission_versions WHERE mission_id = ? ORDER BY number DESC`,
  );
  const one = ctx.db.prepare<[string, number], VersionRow>(
    `SELECT ${COLUMNS} FROM mission_versions WHERE mission_id = ? AND number = ?`,
  );
  return {
    async list(missionId) {
      return listOf.all(missionId).map(toRecord);
    },
    async get(missionId, number) {
      const row = one.get(missionId, number);
      return row ? toRecord(row) : null;
    },
  };
}

export function createVersionPrimitives(ctx: RepoContext): VersionPrimitives {
  const { db } = ctx;
  const missionOf = db.prepare<
    [string],
    { name: string; expires_at: string | null; period_seconds: number | null }
  >('SELECT name, expires_at, period_seconds FROM missions WHERE id = ?');
  const accountsOf = db.prepare<[string], { account_id: string }>(
    'SELECT account_id FROM mission_accounts WHERE mission_id = ? ORDER BY account_id',
  );
  const setsOf = db.prepare<
    [string],
    {
      id: string;
      account_id: string;
      position: number;
      future: number;
      env: string | null;
      mixed_env: number;
      trust_levels_json: string | null;
    }
  >(
    `SELECT id, account_id, position, future, env, mixed_env, trust_levels_json
     FROM mission_resource_sets WHERE mission_id = ? ORDER BY account_id, position, id`,
  );
  const resourcesOf = db.prepare<[string], { resource_id: string; resource_set_id: string }>(
    `SELECT resource_id, resource_set_id FROM mission_resources
     WHERE mission_id = ? ORDER BY resource_id`,
  );
  const policyOf = db.prepare<
    [string],
    {
      resource_set_id: string;
      risk_id: string;
      quota: number;
      rate_limit: number;
      rate_window_seconds: number;
      gate: string;
    }
  >(
    `SELECT resource_set_id, risk_id, quota, rate_limit, rate_window_seconds, gate
     FROM mission_policy WHERE mission_id = ? ORDER BY resource_set_id, risk_id`,
  );
  const latest = db.prepare<[string], { number: number; config_json: string }>(
    `SELECT number, config_json FROM mission_versions
     WHERE mission_id = ? ORDER BY number DESC LIMIT 1`,
  );
  const insert = db.prepare<
    [
      string,
      number,
      string,
      string,
      string,
      string | null,
      string | null,
      number | null,
      string,
      string | null,
    ]
  >(`INSERT INTO mission_versions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  /** The configuration as the tables hold it now; `null` when the mission is gone. */
  function configNow(missionId: string): MissionVersionConfig | null {
    const mission = missionOf.get(missionId);
    if (!mission) return null;
    const ids = new Map<string, string[]>();
    for (const r of resourcesOf.all(missionId)) {
      const list = ids.get(r.resource_set_id) ?? [];
      list.push(r.resource_id);
      ids.set(r.resource_set_id, list);
    }
    const sets = setsOf.all(missionId);
    const accounts = accountsOf.all(missionId).map((c): MissionVersionAccount => ({
      account_id: c.account_id,
      resource_sets: sets
        .filter((set) => set.account_id === c.account_id)
        .map((set): MissionVersionSet => ({
          id: set.id,
          position: set.position,
          future: set.future === 1,
          env: set.env,
          mixed_env: set.mixed_env === 1,
          resource_ids: ids.get(set.id) ?? [],
          trust_levels:
            set.trust_levels_json === null
              ? {}
              : (JSON.parse(set.trust_levels_json) as Record<string, string>),
        })),
    }));
    const policy = policyOf.all(missionId).map((p): MissionVersionLine => ({
      resource_set_id: p.resource_set_id,
      risk_id: p.risk_id,
      quota: p.quota,
      rate_limit: { max: p.rate_limit, window_seconds: p.rate_window_seconds },
      gate: parseEnum(GATES, p.gate, 'mission_policy.gate'),
    }));
    return {
      name: mission.name,
      expires_at: mission.expires_at,
      period:
        mission.period_seconds === null
          ? { kind: 'one-off' }
          : { kind: 'recurring', length_seconds: mission.period_seconds },
      accounts,
      policy,
    };
  }

  return {
    recordSync(missionId, stamp, now) {
      if ((stamp.cause === 'rollback') !== (stamp.restoredFrom !== undefined)) {
        throw new InvariantError('a rollback, and only a rollback, names the version it restores');
      }
      const config = configNow(missionId);
      if (config === null) return null;
      const last = latest.get(missionId);
      const previous = last ? configOf(last.config_json) : null;
      if (previous !== null && sameConfig(previous, config)) return null;
      const number = (last?.number ?? 0) + 1;
      const author = stamp.author;
      const changes = versionChanges(previous, config);
      insert.run(
        missionId,
        number,
        now,
        stamp.cause,
        author.kind,
        author.kind === 'gateway' ? null : author.userId,
        author.kind === 'mission' ? author.missionId : null,
        stamp.restoredFrom ?? null,
        JSON.stringify(config),
        changes === null ? null : JSON.stringify(changes),
      );
      return number;
    },
  };
}
