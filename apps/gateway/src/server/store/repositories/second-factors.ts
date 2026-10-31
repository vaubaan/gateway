/**
 * The second factor of every person (migration 0021; ADR
 * administrators-live-in-the-instance §7): the confirmed TOTP and its recovery codes,
 * sealed, and the count of wrong codes that locks it (migration 0026). Who decides is
 * the auth module's `SecondFactorService`; this is the table.
 */

import { withImmediateTransaction } from '../db.ts';
import { openSealedColumn, sealText } from '../encryptor.ts';
import type { Iso } from '../types.ts';
import { nowIso, type RepoContext } from './context.ts';
import { nextLockout, type LockoutRule } from './local-accounts.ts';

export const SECOND_FACTOR_SECRET_KINDS = ['totp', 'recovery'] as const;
export type SecondFactorSecretKind = (typeof SECOND_FACTOR_SECRET_KINDS)[number];

export interface SecondFactorRecord {
  readonly userId: string;
  readonly confirmedAt: Iso;
  /** The last time step a code was accepted for; `null` before the first. */
  readonly lastStep: number | null;
  /** Wrong codes since `firstFailureAt`. */
  readonly failedAttempts: number;
  readonly firstFailureAt: Iso | null;
  /** No code is checked before this instant. */
  readonly lockedUntil: Iso | null;
  readonly updatedAt: Iso;
}

export interface SecondFactorsRepo {
  get(userId: string): Promise<SecondFactorRecord | null>;
  /**
   * Writes the seed and the recovery codes and marks the factor confirmed, in one
   * transaction. A new factor starts with no wrong code counted.
   */
  set(input: {
    userId: string;
    totp: string;
    recovery: string;
    lastStep: number | null;
    confirmedAt?: Iso;
  }): Promise<void>;
  /** The factor and its secrets are gone. `false` when there was none. */
  remove(userId: string): Promise<boolean>;
  readSecret(userId: string, kind: SecondFactorSecretKind): Promise<string | null>;
  writeSecret(userId: string, kind: SecondFactorSecretKind, plain: string): Promise<void>;
  /** Accepts the step only when it is later than the last one accepted: `false` for a replay. */
  advanceStep(userId: string, step: number): Promise<boolean>;
  /**
   * One more wrong code: the counter restarts when the window has passed, and the
   * factor is locked for `lockMs` at `maxAttempts`. Returns the factor after; `null`
   * when the person has none.
   */
  recordFailure(userId: string, rule: LockoutRule): Promise<SecondFactorRecord | null>;
  /** A code accepted: the counters are cleared. */
  clearFailures(userId: string): Promise<void>;
}

interface FactorRow {
  user_id: string;
  confirmed_at: string;
  last_step: number | null;
  failed_attempts: number;
  first_failure_at: string | null;
  locked_until: string | null;
  updated_at: string;
}

interface SecretRow {
  id: string;
  blob: Buffer;
  key_version: number;
}

/** The associated data of a factor secret's blob. */
export function secondFactorSecretAd(id: string): string {
  return `user-second-factor:${id}`;
}

function secretId(userId: string, kind: SecondFactorSecretKind): string {
  return `${userId}:${kind}`;
}

export function createSecondFactorsRepo(ctx: RepoContext): SecondFactorsRepo {
  const { db, encryptor } = ctx;
  const byUser = db.prepare<[string], FactorRow>(
    `SELECT user_id, confirmed_at, last_step, failed_attempts, first_failure_at, locked_until,
            updated_at
     FROM user_second_factors WHERE user_id = ?`,
  );
  const upsertFactor = db.prepare<[string, string, number | null, string]>(
    `INSERT INTO user_second_factors (user_id, confirmed_at, last_step, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       confirmed_at = excluded.confirmed_at,
       last_step = excluded.last_step,
       failed_attempts = 0,
       first_failure_at = NULL,
       locked_until = NULL,
       updated_at = excluded.updated_at`,
  );
  const deleteFactor = db.prepare<[string]>('DELETE FROM user_second_factors WHERE user_id = ?');
  const deleteSecrets = db.prepare<[string]>(
    'DELETE FROM user_second_factor_secrets WHERE user_id = ?',
  );
  const secretById = db.prepare<[string], SecretRow>(
    'SELECT id, blob, key_version FROM user_second_factor_secrets WHERE id = ?',
  );
  const upsertSecret = db.prepare<[string, string, string, Buffer, number, string]>(
    `INSERT INTO user_second_factor_secrets (id, user_id, kind, blob, key_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       blob = excluded.blob,
       key_version = excluded.key_version,
       updated_at = excluded.updated_at`,
  );
  const advance = db.prepare<[number, string, string, number]>(
    `UPDATE user_second_factors SET last_step = ?, updated_at = ?
     WHERE user_id = ? AND (last_step IS NULL OR last_step < ?)`,
  );
  const updateFailure = db.prepare<[number, string | null, string | null, string, string]>(
    `UPDATE user_second_factors
     SET failed_attempts = ?, first_failure_at = ?, locked_until = ?, updated_at = ?
     WHERE user_id = ?`,
  );
  const clearFailure = db.prepare<[string, string]>(
    `UPDATE user_second_factors
     SET failed_attempts = 0, first_failure_at = NULL, locked_until = NULL, updated_at = ?
     WHERE user_id = ?`,
  );

  const toRecord = (row: FactorRow): SecondFactorRecord => ({
    userId: row.user_id,
    confirmedAt: row.confirmed_at,
    lastStep: row.last_step,
    failedAttempts: row.failed_attempts,
    firstFailureAt: row.first_failure_at,
    lockedUntil: row.locked_until,
    updatedAt: row.updated_at,
  });

  return {
    async get(userId) {
      const row = byUser.get(userId);
      return row ? toRecord(row) : null;
    },
    async set(input) {
      const now = nowIso(ctx);
      const totpId = secretId(input.userId, 'totp');
      const recoveryId = secretId(input.userId, 'recovery');
      const totp = await sealText(encryptor, secondFactorSecretAd(totpId), input.totp);
      const recovery = await sealText(encryptor, secondFactorSecretAd(recoveryId), input.recovery);
      withImmediateTransaction(db, () => {
        upsertSecret.run(totpId, input.userId, 'totp', totp.blob, totp.keyVersion, now);
        upsertSecret.run(
          recoveryId,
          input.userId,
          'recovery',
          recovery.blob,
          recovery.keyVersion,
          now,
        );
        upsertFactor.run(input.userId, input.confirmedAt ?? now, input.lastStep, now);
      });
    },
    async remove(userId) {
      return withImmediateTransaction(db, () => {
        deleteSecrets.run(userId);
        return deleteFactor.run(userId).changes > 0;
      });
    },
    async readSecret(userId, kind) {
      const id = secretId(userId, kind);
      const row = secretById.get(id);
      if (!row) return null;
      return openSealedColumn(encryptor, secondFactorSecretAd(id), row.blob, row.key_version);
    },
    async writeSecret(userId, kind, plain) {
      const id = secretId(userId, kind);
      const sealed = await sealText(encryptor, secondFactorSecretAd(id), plain);
      upsertSecret.run(id, userId, kind, sealed.blob, sealed.keyVersion, nowIso(ctx));
    },
    async advanceStep(userId, step) {
      return advance.run(step, nowIso(ctx), userId, step).changes > 0;
    },
    async recordFailure(userId, rule) {
      return withImmediateTransaction(db, () => {
        const row = byUser.get(userId);
        if (!row) return null;
        const next = nextLockout(toRecord(row), rule, ctx.clock.now());
        updateFailure.run(
          next.failedAttempts,
          next.firstFailureAt,
          next.lockedUntil,
          nowIso(ctx),
          userId,
        );
        const after = byUser.get(userId);
        return after ? toRecord(after) : null;
      });
    },
    async clearFailures(userId) {
      clearFailure.run(nowIso(ctx), userId);
    },
  };
}
