import { withImmediateTransaction } from '../db.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import { USER_STATUSES, type UserRecord } from '../types.ts';
import { nowIso, parseEnum, requireRow, type RepoContext } from './context.ts';

/**
 * Who the identity provider says signed in. A user is the pair `(issuer, subject)`:
 * OpenID Connect makes a subject unique within its issuer only, so the subject alone
 * would let a second identity provider hand an existing account to another person
 * (migration 0011).
 */
export interface UpsertUserInput {
  /** The `iss` of the validated ID token, exactly as issued. */
  readonly issuer: string;
  /** The subject claim, exactly as issued. */
  readonly subject: string;
  readonly email: string;
  readonly displayName?: string | null;
}

export interface UsersRepo {
  /**
   * Creates the user on first login, refreshes email/display name/last login afterwards.
   * Never changes the status: a deactivated user stays `removed` whatever the identity
   * provider says (`reactivate` is the only way back).
   */
  upsertFromIdp(input: UpsertUserInput): Promise<UserRecord>;
  getById(id: string): Promise<UserRecord | null>;
  /** The account of this subject AT THIS ISSUER; the same subject elsewhere is somebody else. */
  getByIdentity(issuer: string, subject: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord[]>;
  list(): Promise<UserRecord[]>;
  /**
   * Binds every account created before migration 0011 (no issuer recorded) to
   * `issuer`, and returns how many were bound. Called with the issuer of a sign-in
   * that was just validated, before the account is looked up: the first sign-in after
   * the upgrade names the identity provider those accounts came from, for all of them
   * at once, so none stays open to be matched by another issuer later. A no-op once
   * done.
   */
  bindUnboundTo(issuer: string): Promise<number>;
  /**
   * Deactivation: the user is `removed`. They hold no authority from then on, so their
   * missions read `orphaned` (derived, `MissionGrounds`), and every session they had
   * open is ended (`sessions_ended_at`). Idempotent on the status; the instants move.
   */
  markRemoved(id: string): Promise<UserRecord>;
  /**
   * A `removed` user is `active` again. `sessions_ended_at` stays: what was open before
   * the deactivation is not reopened. Returns `null` when the user is unknown or was
   * not removed (nothing was written).
   */
  reactivate(id: string): Promise<UserRecord | null>;
  /**
   * Ends every web session of the users recorded under `issuer` (with or without a
   * trailing slash): `sessions_ended_at` = now, the status untouched. A sign-in
   * provider was removed; its users' next request finds no session. Returns how
   * many users were concerned.
   */
  endSessionsOfIssuer(issuer: string): Promise<number>;
}

interface UserRow {
  id: string;
  issuer: string | null;
  subject: string;
  email: string;
  display_name: string | null;
  status: string;
  created_at: string;
  last_login_at: string | null;
  removed_at: string | null;
  sessions_ended_at: string | null;
}

const COLUMNS =
  'id, issuer, subject, email, display_name, status, created_at, last_login_at, removed_at, sessions_ended_at';

/**
 * An issuer as an ID token carries it: a URL, so a scheme and no whitespace. The
 * second property is what makes `identityKeyOf` injective.
 */
const ISSUER_SHAPE = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

/**
 * The value of `users.identity_key`, the column that carries the UNIQUE constraint:
 * `<issuer> <subject>`. The issuer holds no space, so the first space splits the two
 * and two different pairs never share a key.
 */
export function identityKeyOf(issuer: string, subject: string): string {
  if (!ISSUER_SHAPE.test(issuer)) {
    throw new InvariantError('a user issuer must be a URL without whitespace');
  }
  if (subject.length === 0) throw new InvariantError('a user subject must not be empty');
  return `${issuer} ${subject}`;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    issuer: row.issuer,
    subject: row.subject,
    email: row.email,
    displayName: row.display_name,
    status: parseEnum(USER_STATUSES, row.status, 'users.status'),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    removedAt: row.removed_at,
    sessionsEndedAt: row.sessions_ended_at,
  };
}

export function getUserRow(ctx: RepoContext, id: string): UserRow | undefined {
  return ctx.db.prepare<[string], UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id);
}

export function requireUser(ctx: RepoContext, id: string): UserRecord {
  const row = getUserRow(ctx, id);
  if (!row) throw new NotFoundError('user', id);
  return toRecord(row);
}

export function createUsersRepo(ctx: RepoContext): UsersRepo {
  const { db } = ctx;
  const upsert = db.prepare<
    [string, string, string, string, string, string | null, string, string]
  >(
    `INSERT INTO users (id, identity_key, issuer, subject, email, display_name, status, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT (identity_key) DO UPDATE SET
       email = excluded.email,
       display_name = excluded.display_name,
       last_login_at = excluded.last_login_at`,
  );
  const byIdentityKey = db.prepare<[string], UserRow>(
    `SELECT ${COLUMNS} FROM users WHERE identity_key = ?`,
  );
  const byEmail = db.prepare<[string], UserRow>(
    `SELECT ${COLUMNS} FROM users WHERE email = ? ORDER BY created_at`,
  );
  const all = db.prepare<[], UserRow>(`SELECT ${COLUMNS} FROM users ORDER BY created_at`);
  // An account that would collide with one already bound to this issuer is left unbound
  // (and therefore unreachable) rather than failing the sign-in that triggered the bind.
  const bindUnbound = db.prepare<[string, string, string]>(
    `UPDATE users SET issuer = ?, identity_key = ? || ' ' || subject
     WHERE issuer IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM users bound WHERE bound.identity_key = ? || ' ' || users.subject
       )`,
  );
  const remove = db.prepare<[string, string, string]>(
    `UPDATE users SET status = 'removed', removed_at = ?, sessions_ended_at = ? WHERE id = ?`,
  );
  const endSessions = db.prepare<[string, string, string]>(
    'UPDATE users SET sessions_ended_at = ? WHERE issuer = ? OR issuer = ?',
  );
  const restore = db.prepare<[string]>(
    `UPDATE users SET status = 'active', removed_at = NULL WHERE id = ? AND status = 'removed'`,
  );

  return {
    async upsertFromIdp(input) {
      const key = identityKeyOf(input.issuer, input.subject);
      const now = nowIso(ctx);
      upsert.run(
        ctx.newId(),
        key,
        input.issuer,
        input.subject,
        input.email,
        input.displayName ?? null,
        now,
        now,
      );
      return toRecord(requireRow(byIdentityKey.get(key), 'user', input.subject));
    },
    async endSessionsOfIssuer(issuer) {
      const bare = issuer.replace(/\/+$/, '');
      return withImmediateTransaction(
        db,
        () => endSessions.run(nowIso(ctx), bare, `${bare}/`).changes,
      );
    },
    async getById(id) {
      const row = getUserRow(ctx, id);
      return row ? toRecord(row) : null;
    },
    async getByIdentity(issuer, subject) {
      const row = byIdentityKey.get(identityKeyOf(issuer, subject));
      return row ? toRecord(row) : null;
    },
    async findByEmail(email) {
      return byEmail.all(email).map(toRecord);
    },
    async list() {
      return all.all().map(toRecord);
    },
    async bindUnboundTo(issuer) {
      // Validates the issuer the same way a key is built.
      identityKeyOf(issuer, 'x');
      return withImmediateTransaction(db, () => bindUnbound.run(issuer, issuer, issuer).changes);
    },
    async markRemoved(id) {
      const now = nowIso(ctx);
      const result = remove.run(now, now, id);
      if (result.changes === 0) throw new NotFoundError('user', id);
      return requireUser(ctx, id);
    },
    async reactivate(id) {
      return restore.run(id).changes > 0 ? requireUser(ctx, id) : null;
    },
  };
}

/** The user column list under alias `u`, for joins (`group_members`). */
export function userColumns(alias: string): string {
  return COLUMNS.split(', ')
    .map((c) => `${alias}.${c}`)
    .join(', ');
}

export { toRecord as userRowToRecord, type UserRow };
