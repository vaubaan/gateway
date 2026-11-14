import { assertKnownRiskIds } from '../catalog-index.ts';
import { withImmediateTransaction } from '../db.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import type { Principal, RiskId, ShareRecord } from '../types.ts';
import {
  nowIso,
  parseEnum,
  principalColumns,
  principalFromColumns,
  principalPredicate,
  type RepoContext,
} from './context.ts';
import { SHARE_STATUSES } from './enums.ts';

export interface CreateShareInput {
  readonly accountId: string;
  readonly target: Principal;
  /** Explicit enumeration; every id must exist in the loaded catalog. Empty authorizes nothing. */
  readonly restriction: readonly RiskId[];
  readonly createdByUserId: string;
}

/**
 * One share, named by its account and its id together: no repository method reads
 * or changes a share by its id alone, so a caller that forgot the account reaches
 * nothing (security audit 2026-10-31, L8). A share of another account reads as
 * missing.
 */
export interface ShareKey {
  readonly accountId: string;
  readonly shareId: string;
}

export interface SharesRepo {
  create(input: CreateShareInput): Promise<ShareRecord>;
  /** The share, if it is one of that account's; `null` otherwise. */
  get(key: ShareKey): Promise<ShareRecord | null>;
  listForAccount(accountId: string): Promise<ShareRecord[]>;
  /**
   * Active shares whose target is any of the principals (a user and their groups),
   * on one account when `accountId` is given.
   */
  listActiveForTargets(
    principals: readonly Principal[],
    accountId?: string,
  ): Promise<ShareRecord[]>;
  /**
   * The share of an account to a target, replaced: the active share of the same
   * `(account, target)`, if any, is revoked and the new one created, in one
   * transaction, so a target never holds two active shares of one account and never
   * holds none in between.
   */
  replaceForTarget(
    input: CreateShareInput,
  ): Promise<{ created: ShareRecord; replaced: ShareRecord | null }>;
  /**
   * Revokes an active share of that account. `NotFoundError` for an unknown share or
   * another account's; `InvariantError` when it is already revoked.
   */
  revoke(key: ShareKey): Promise<ShareRecord>;
}

interface ShareRow {
  id: string;
  account_id: string;
  target_kind: string;
  target_user_id: string | null;
  target_group_id: string | null;
  status: string;
  created_by_user_id: string;
  created_at: string;
  revoked_at: string | null;
}

const COLUMNS = `id, account_id, target_kind, target_user_id, target_group_id, status,
  created_by_user_id, created_at, revoked_at`;
/** Distinct compiled shapes of `listActiveForTargets` kept at once. */
const MAX_ACTIVE_STATEMENTS = 64;

export function createSharesRepo(ctx: RepoContext): SharesRepo {
  const { db } = ctx;
  const byId = db.prepare<[string], ShareRow>(`SELECT ${COLUMNS} FROM shares WHERE id = ?`);
  const byKey = db.prepare<[string, string], ShareRow>(
    `SELECT ${COLUMNS} FROM shares WHERE account_id = ? AND id = ?`,
  );
  const byAccount = db.prepare<[string], ShareRow>(
    `SELECT ${COLUMNS} FROM shares WHERE account_id = ? ORDER BY created_at`,
  );
  const insert = db.prepare<[string, string, string, string | null, string | null, string, string]>(
    `INSERT INTO shares (id, account_id, target_kind, target_user_id, target_group_id, status,
       created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  );
  const insertRisk = db.prepare<[string, string]>(
    'INSERT INTO share_restrictions (share_id, risk_id) VALUES (?, ?)',
  );
  const risksOf = db.prepare<[string], { risk_id: string }>(
    'SELECT risk_id FROM share_restrictions WHERE share_id = ? ORDER BY risk_id',
  );
  const revokeActive = db.prepare<[string, string]>(
    `UPDATE shares SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'`,
  );
  const revokeActiveOfAccount = db.prepare<[string, string, string]>(
    `UPDATE shares SET status = 'revoked', revoked_at = ?
     WHERE account_id = ? AND id = ? AND status = 'active'`,
  );

  // The execution door asks `listActiveForTargets` on every call of a mission grounded
  // in a share. Its SQL text only varies with the number of principals, so the compiled
  // statement is kept per text: a handful of shapes, bounded, tied to this handle.
  const activeStatements = new Map<string, ReturnType<typeof prepareActive>>();
  function prepareActive(sql: string) {
    return db.prepare<string[], ShareRow>(sql);
  }
  function activeForTargets(sql: string) {
    let statement = activeStatements.get(sql);
    if (!statement) {
      if (activeStatements.size >= MAX_ACTIVE_STATEMENTS) activeStatements.clear();
      statement = prepareActive(sql);
      activeStatements.set(sql, statement);
    }
    return statement;
  }

  function toRecord(row: ShareRow): ShareRecord {
    return {
      id: row.id,
      accountId: row.account_id,
      target: principalFromColumns(row.target_kind, row.target_user_id, row.target_group_id),
      restriction: risksOf.all(row.id).map((r) => r.risk_id),
      status: parseEnum(SHARE_STATUSES, row.status, 'shares.status'),
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  function requireShare(id: string): ShareRecord {
    const row = byId.get(id);
    if (!row) throw new NotFoundError('share', id);
    return toRecord(row);
  }

  /** Inside a transaction: the share row and one restriction row per risk. */
  function insertShare(id: string, input: CreateShareInput, risks: readonly RiskId[], now: string) {
    const target = principalColumns(input.target);
    insert.run(
      id,
      input.accountId,
      target.kind,
      target.userId,
      target.groupId,
      input.createdByUserId,
      now,
    );
    for (const riskId of risks) insertRisk.run(id, riskId);
  }

  return {
    async create(input) {
      const unique = [...new Set(input.restriction)];
      assertKnownRiskIds(ctx.catalog, unique);
      const id = ctx.newId();
      const now = nowIso(ctx);
      withImmediateTransaction(db, () => insertShare(id, input, unique, now));
      return requireShare(id);
    },
    async replaceForTarget(input) {
      const unique = [...new Set(input.restriction)];
      assertKnownRiskIds(ctx.catalog, unique);
      const id = ctx.newId();
      const now = nowIso(ctx);
      const pred = principalPredicate([input.target], 'target_user_id', 'target_group_id');
      const replaced = withImmediateTransaction(db, () => {
        const previous = db
          .prepare<string[], ShareRow>(
            `SELECT ${COLUMNS} FROM shares
             WHERE status = 'active' AND account_id = ? AND ${pred.sql} ORDER BY created_at`,
          )
          .all(input.accountId, ...pred.params)
          .map(toRecord);
        for (const share of previous) revokeActive.run(now, share.id);
        insertShare(id, input, unique, now);
        return previous;
      });
      return { created: requireShare(id), replaced: replaced.at(-1) ?? null };
    },
    async get({ accountId, shareId }) {
      const row = byKey.get(accountId, shareId);
      return row ? toRecord(row) : null;
    },
    async listForAccount(accountId) {
      return byAccount.all(accountId).map(toRecord);
    },
    async listActiveForTargets(principals, accountId) {
      const pred = principalPredicate(principals, 'target_user_id', 'target_group_id');
      const onAccount = accountId === undefined ? '' : ' AND account_id = ?';
      return activeForTargets(
        `SELECT ${COLUMNS} FROM shares
         WHERE status = 'active' AND ${pred.sql}${onAccount} ORDER BY created_at`,
      )
        .all(...pred.params, ...(accountId === undefined ? [] : [accountId]))
        .map(toRecord);
    },
    async revoke({ accountId, shareId }) {
      // The conditional UPDATE is the check; the re-read only picks the error.
      const changed = revokeActiveOfAccount.run(nowIso(ctx), accountId, shareId).changes;
      const row = byKey.get(accountId, shareId);
      if (!row) throw new NotFoundError('share', shareId);
      if (changed === 0) throw new InvariantError(`share ${shareId} is already revoked`);
      return toRecord(row);
    },
  };
}
