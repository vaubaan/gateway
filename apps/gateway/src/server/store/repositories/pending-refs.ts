/**
 * Temporary refs a push created at the provider (spec §4.1 ter "Git remote";
 * migration 0015; ADR gateway-as-git-remote D5). The git door records each
 * one before the pack leaves, with the request's deadline, and drops the row
 * once the provider confirmed the ref deleted; a push answered
 * `approval-required` moves the deadline to the request's expiry. The
 * sweeper deletes at the provider what outlived its deadline (a crash, a
 * client gone, a provider that did not answer or refused the delete). The
 * pack itself is never stored here.
 */

import type { Iso } from '../types.ts';
import { nowIso, type RepoContext } from './context.ts';

export interface PendingRefRecord {
  /** `refs/vaubaan/<random>`. */
  readonly ref: string;
  /** The branch or tag the push asked for (`refs/heads/feature/x`). */
  readonly targetRef: string;
  readonly accountId: string;
  /** `owner/repo`. */
  readonly repository: string;
  readonly missionId: string;
  /** What the ref points at; the delete swaps it for nothing. */
  readonly objectId: string;
  readonly expiresAt: Iso;
  readonly createdAt: Iso;
}

export type NewPendingRef = Omit<PendingRefRecord, 'createdAt'>;

export interface PendingRefsRepo {
  add(refs: readonly NewPendingRef[]): Promise<void>;
  /** Rows whose deadline is `now` or before, oldest first, at most `limit`. */
  listExpired(now: Iso, limit: number): Promise<PendingRefRecord[]>;
  /** The rows of one mission on one repository (a replay cleans what its request left). */
  listFor(missionId: string, repository: string): Promise<PendingRefRecord[]>;
  /** How many temporary refs one mission holds at the provider, in flight or pending. */
  countFor(missionId: string): Promise<number>;
  /** Moves the deadline of these rows (a push now waiting for an approval; a delete to retry). */
  extend(refs: readonly string[], expiresAt: Iso): Promise<void>;
  /** Drops the rows; returns how many existed. */
  remove(refs: readonly string[]): Promise<number>;
}

interface PendingRefRow {
  ref: string;
  target_ref: string;
  account_id: string;
  repository: string;
  mission_id: string;
  object_id: string;
  expires_at: string;
  created_at: string;
}

const COLUMNS =
  'ref, target_ref, account_id, repository, mission_id, object_id, expires_at, created_at';

function toRecord(row: PendingRefRow): PendingRefRecord {
  return {
    ref: row.ref,
    targetRef: row.target_ref,
    accountId: row.account_id,
    repository: row.repository,
    missionId: row.mission_id,
    objectId: row.object_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function createPendingRefsRepo(ctx: RepoContext): PendingRefsRepo {
  const { db } = ctx;
  const insert = db.prepare<[string, string, string, string, string, string, string, string]>(
    `INSERT INTO git_pending_refs (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (ref) DO NOTHING`,
  );
  const expired = db.prepare<[string, number], PendingRefRow>(
    `SELECT ${COLUMNS} FROM git_pending_refs WHERE expires_at <= ?
     ORDER BY expires_at, ref LIMIT ?`,
  );
  const forMission = db.prepare<[string, string], PendingRefRow>(
    `SELECT ${COLUMNS} FROM git_pending_refs WHERE mission_id = ? AND repository = ? ORDER BY ref`,
  );
  const count = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM git_pending_refs WHERE mission_id = ?',
  );
  const remove = db.prepare<[string]>('DELETE FROM git_pending_refs WHERE ref = ?');
  const setExpiry = db.prepare<[string, string]>(
    'UPDATE git_pending_refs SET expires_at = ? WHERE ref = ?',
  );
  const insertAll = db.transaction((rows: readonly NewPendingRef[], createdAt: string) => {
    for (const r of rows) {
      insert.run(
        r.ref,
        r.targetRef,
        r.accountId,
        r.repository,
        r.missionId,
        r.objectId,
        r.expiresAt,
        createdAt,
      );
    }
  });
  const extendAll = db.transaction((refs: readonly string[], expiresAt: string) => {
    for (const ref of refs) setExpiry.run(expiresAt, ref);
  });
  const removeAll = db.transaction((refs: readonly string[]) =>
    refs.reduce((n, ref) => n + remove.run(ref).changes, 0),
  );

  return {
    async add(refs) {
      if (refs.length > 0) insertAll(refs, nowIso(ctx));
    },
    async listExpired(now, limit) {
      return expired.all(now, limit).map(toRecord);
    },
    async listFor(missionId, repository) {
      return forMission.all(missionId, repository).map(toRecord);
    },
    async countFor(missionId) {
      return count.get(missionId)?.n ?? 0;
    },
    async extend(refs, expiresAt) {
      if (refs.length > 0) extendAll(refs, expiresAt);
    },
    async remove(refs) {
      return refs.length === 0 ? 0 : removeAll(refs);
    },
  };
}
