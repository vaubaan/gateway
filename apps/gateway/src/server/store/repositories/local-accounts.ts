/**
 * Local accounts (spec §0 "Local account"; migration 0019; ADR
 * local-accounts-sign-in-provider): the accounts of a sign-in provider of kind
 * `local`, their sealed secrets and the single-use links. Who decides is the
 * authentication module (`auth/local-accounts.ts`); these are the tables.
 *
 * Secrets: one row of `local_secrets` per (account, kind), the blob sealed with
 * `local-secret:<account id>:<kind>` as associated data, so that a blob moved to
 * another row fails to open. The table is in `SEALED_COLUMNS`: a key rotation
 * reseals it with everything else.
 *
 * Links: the store keeps the SHA-256 of the token only. A link is consumed by
 * `useLink`, which succeeds once; creating a link retires the unused ones of the
 * same kind for the same address, so that only the latest mail is valid.
 */

import { withImmediateTransaction } from '../db.ts';
import { openSealedColumn, sealText } from '../encryptor.ts';
import type { Iso } from '../types.ts';
import { nowIso, type RepoContext } from './context.ts';

export const LOCAL_SECRET_KINDS = ['password', 'totp', 'recovery'] as const;
export type LocalSecretKind = (typeof LOCAL_SECRET_KINDS)[number];

export const LOCAL_LINK_KINDS = ['invite', 'reset'] as const;
export type LocalLinkKind = (typeof LOCAL_LINK_KINDS)[number];

export interface LocalAccountRecord {
  readonly id: string;
  readonly provider: string;
  /** Lower-cased. */
  readonly email: string;
  /** When the second factor was confirmed; `null`: none. */
  readonly totpConfirmedAt: Iso | null;
  /** The last time step a code was accepted for: a code is never accepted twice. */
  readonly totpLastStep: number | null;
  readonly failedAttempts: number;
  readonly firstFailureAt: Iso | null;
  readonly lockedUntil: Iso | null;
  readonly passwordChangedAt: Iso | null;
  readonly createdAt: Iso;
  readonly updatedAt: Iso;
}

export interface LocalLinkRecord {
  readonly id: string;
  readonly kind: LocalLinkKind;
  readonly provider: string;
  readonly email: string;
  /** A user id, `bootstrap`, or `self` (a reset the person asked for). */
  readonly createdBy: string;
  readonly createdAt: Iso;
  readonly expiresAt: Iso;
  readonly usedAt: Iso | null;
}

/** How wrong passwords are counted and when they lock the account. */
export interface LockoutRule {
  readonly maxAttempts: number;
  readonly windowMs: number;
  readonly lockMs: number;
}

export interface LocalAccountsRepo {
  /** `null` when the provider already has an account for this address. */
  create(input: { provider: string; email: string }): Promise<LocalAccountRecord | null>;
  getById(id: string): Promise<LocalAccountRecord | null>;
  getByEmail(provider: string, email: string): Promise<LocalAccountRecord | null>;
  /** Of one provider, oldest first. */
  list(provider: string): Promise<LocalAccountRecord[]>;
  /** The account and its secrets. */
  remove(id: string): Promise<boolean>;
  /** The clear text of a secret, or `null` when the account has none of that kind. */
  readSecret(accountId: string, kind: LocalSecretKind): Promise<string | null>;
  writeSecret(accountId: string, kind: LocalSecretKind, plain: string): Promise<void>;
  deleteSecret(accountId: string, kind: LocalSecretKind): Promise<boolean>;
  /**
   * One more wrong password: the counter restarts when the window has passed, and
   * the account is locked for `lockMs` at `maxAttempts`. Returns the account after.
   */
  recordFailure(id: string, rule: LockoutRule): Promise<LocalAccountRecord | null>;
  /** A correct password: the counters are cleared. */
  clearFailures(id: string): Promise<void>;
  setTotp(id: string, state: { confirmedAt: Iso | null; lastStep: number | null }): Promise<void>;
  /** Accepts the step only when it is later than the last one accepted: `false` for a replay. */
  advanceTotpStep(id: string, step: number): Promise<boolean>;
  markPasswordChanged(id: string): Promise<void>;
  /** Retires the unused links of that kind for the address, then records the new one. */
  createLink(input: {
    kind: LocalLinkKind;
    provider: string;
    email: string;
    tokenSha256: string;
    createdBy: string;
    expiresAt: Iso;
  }): Promise<LocalLinkRecord>;
  getLinkByToken(tokenSha256: string): Promise<LocalLinkRecord | null>;
  /** Marks the link used; `false` when it was used already (or does not exist). */
  useLink(id: string): Promise<boolean>;
  /** The unused links for the address, newest first (People: "a link is pending"). */
  pendingLinks(provider: string, email: string): Promise<LocalLinkRecord[]>;
}

interface AccountRow {
  id: string;
  provider: string;
  email: string;
  totp_confirmed_at: string | null;
  totp_last_step: number | null;
  failed_attempts: number;
  first_failure_at: string | null;
  locked_until: string | null;
  password_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LinkRow {
  id: string;
  kind: string;
  provider: string;
  email: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

const ACCOUNT_COLUMNS =
  'id, provider, email, totp_confirmed_at, totp_last_step, failed_attempts, first_failure_at, locked_until, password_changed_at, created_at, updated_at';
const LINK_COLUMNS = 'id, kind, provider, email, created_by, created_at, expires_at, used_at';

function toAccount(row: AccountRow): LocalAccountRecord {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    totpConfirmedAt: row.totp_confirmed_at,
    totpLastStep: row.totp_last_step,
    failedAttempts: row.failed_attempts,
    firstFailureAt: row.first_failure_at,
    lockedUntil: row.locked_until,
    passwordChangedAt: row.password_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLink(row: LinkRow): LocalLinkRecord {
  return {
    id: row.id,
    kind: row.kind === 'reset' ? 'reset' : 'invite',
    provider: row.provider,
    email: row.email,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

/** The associated data of a secret's blob. */
export function localSecretAd(id: string): string {
  return `local-secret:${id}`;
}

function secretId(accountId: string, kind: LocalSecretKind): string {
  return `${accountId}:${kind}`;
}

export function createLocalAccountsRepo(ctx: RepoContext): LocalAccountsRepo {
  const { db, encryptor } = ctx;
  const normalize = (email: string): string => email.trim().toLowerCase();

  const insertAccount = db.prepare<[string, string, string, string, string]>(
    `INSERT INTO local_accounts (id, provider, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (provider, email) DO NOTHING`,
  );
  const accountById = db.prepare<[string], AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM local_accounts WHERE id = ?`,
  );
  const accountByEmail = db.prepare<[string, string], AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM local_accounts WHERE provider = ? AND email = ?`,
  );
  const accountsOf = db.prepare<[string], AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM local_accounts WHERE provider = ? ORDER BY created_at, email`,
  );
  const deleteAccount = db.prepare<[string]>('DELETE FROM local_accounts WHERE id = ?');
  const deleteSecretsOf = db.prepare<[string]>('DELETE FROM local_secrets WHERE account_id = ?');
  const secretById = db.prepare<[string], { blob: Buffer; key_version: number }>(
    'SELECT blob, key_version FROM local_secrets WHERE id = ?',
  );
  const upsertSecret = db.prepare<[string, string, string, Buffer, number, string]>(
    `INSERT INTO local_secrets (id, account_id, kind, blob, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET blob = excluded.blob, key_version = excluded.key_version,
       updated_at = excluded.updated_at`,
  );
  const deleteSecret = db.prepare<[string]>('DELETE FROM local_secrets WHERE id = ?');
  const updateFailure = db.prepare<[number, string | null, string | null, string, string]>(
    `UPDATE local_accounts SET failed_attempts = ?, first_failure_at = ?, locked_until = ?, updated_at = ?
     WHERE id = ?`,
  );
  const clearFailure = db.prepare<[string, string]>(
    `UPDATE local_accounts SET failed_attempts = 0, first_failure_at = NULL, locked_until = NULL, updated_at = ?
     WHERE id = ?`,
  );
  const updateTotp = db.prepare<[string | null, number | null, string, string]>(
    'UPDATE local_accounts SET totp_confirmed_at = ?, totp_last_step = ?, updated_at = ? WHERE id = ?',
  );
  const advanceStep = db.prepare<[number, string, string, number]>(
    `UPDATE local_accounts SET totp_last_step = ?, updated_at = ?
     WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`,
  );
  const passwordChanged = db.prepare<[string, string, string]>(
    'UPDATE local_accounts SET password_changed_at = ?, updated_at = ? WHERE id = ?',
  );
  const retireLinks = db.prepare<[string, string, string, string]>(
    `UPDATE local_links SET used_at = ? WHERE kind = ? AND provider = ? AND email = ? AND used_at IS NULL`,
  );
  const insertLink = db.prepare<[string, string, string, string, string, string, string, string]>(
    `INSERT INTO local_links (id, kind, provider, email, token_sha256, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const linkById = db.prepare<[string], LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM local_links WHERE id = ?`,
  );
  const linkByToken = db.prepare<[string], LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM local_links WHERE token_sha256 = ?`,
  );
  const useLinkStmt = db.prepare<[string, string]>(
    'UPDATE local_links SET used_at = ? WHERE id = ? AND used_at IS NULL',
  );
  const pendingOf = db.prepare<[string, string, string], LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM local_links
     WHERE provider = ? AND email = ? AND used_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC`,
  );

  return {
    async create(input) {
      const now = nowIso(ctx);
      const id = ctx.newId();
      const email = normalize(input.email);
      if (insertAccount.run(id, input.provider, email, now, now).changes === 0) return null;
      const row = accountById.get(id);
      return row ? toAccount(row) : null;
    },
    async getById(id) {
      const row = accountById.get(id);
      return row ? toAccount(row) : null;
    },
    async getByEmail(provider, email) {
      const row = accountByEmail.get(provider, normalize(email));
      return row ? toAccount(row) : null;
    },
    async list(provider) {
      return accountsOf.all(provider).map(toAccount);
    },
    async remove(id) {
      return withImmediateTransaction(db, () => {
        deleteSecretsOf.run(id);
        return deleteAccount.run(id).changes > 0;
      });
    },
    async readSecret(accountId, kind) {
      const id = secretId(accountId, kind);
      const row = secretById.get(id);
      if (!row) return null;
      return openSealedColumn(encryptor, localSecretAd(id), row.blob, row.key_version);
    },
    async writeSecret(accountId, kind, plain) {
      const id = secretId(accountId, kind);
      const sealed = await sealText(encryptor, localSecretAd(id), plain);
      upsertSecret.run(id, accountId, kind, sealed.blob, sealed.keyVersion, nowIso(ctx));
    },
    async deleteSecret(accountId, kind) {
      return deleteSecret.run(secretId(accountId, kind)).changes > 0;
    },
    async recordFailure(id, rule) {
      return withImmediateTransaction(db, () => {
        const row = accountById.get(id);
        if (!row) return null;
        const now = ctx.clock.now();
        const nowIsoText = nowIso(ctx);
        const firstAt = row.first_failure_at ? Date.parse(row.first_failure_at) : NaN;
        const inWindow = Number.isFinite(firstAt) && now.getTime() - firstAt < rule.windowMs;
        const attempts = inWindow ? row.failed_attempts + 1 : 1;
        const firstFailureAt = inWindow ? row.first_failure_at : nowIsoText;
        const lockedUntil =
          attempts >= rule.maxAttempts
            ? new Date(now.getTime() + rule.lockMs).toISOString()
            : row.locked_until;
        updateFailure.run(attempts, firstFailureAt, lockedUntil, nowIsoText, id);
        const after = accountById.get(id);
        return after ? toAccount(after) : null;
      });
    },
    async clearFailures(id) {
      clearFailure.run(nowIso(ctx), id);
    },
    async setTotp(id, state) {
      updateTotp.run(state.confirmedAt, state.lastStep, nowIso(ctx), id);
    },
    async advanceTotpStep(id, step) {
      return advanceStep.run(step, nowIso(ctx), id, step).changes > 0;
    },
    async markPasswordChanged(id) {
      const now = nowIso(ctx);
      passwordChanged.run(now, now, id);
    },
    async createLink(input) {
      const email = normalize(input.email);
      return withImmediateTransaction(db, () => {
        const now = nowIso(ctx);
        retireLinks.run(now, input.kind, input.provider, email);
        const id = ctx.newId();
        insertLink.run(
          id,
          input.kind,
          input.provider,
          email,
          input.tokenSha256,
          input.createdBy,
          now,
          input.expiresAt,
        );
        const row = linkById.get(id);
        if (!row) throw new Error('local link not found after insert');
        return toLink(row);
      });
    },
    async getLinkByToken(tokenSha256) {
      const row = linkByToken.get(tokenSha256);
      return row ? toLink(row) : null;
    },
    async useLink(id) {
      return useLinkStmt.run(nowIso(ctx), id).changes > 0;
    },
    async pendingLinks(provider, email) {
      return pendingOf.all(provider, normalize(email), nowIso(ctx)).map(toLink);
    },
  };
}
