import { NotFoundError } from '../errors.ts';
import { USER_STATUSES, type UserRecord } from '../types.ts';
import { nowIso, parseEnum, requireRow, type RepoContext } from './context.ts';

export interface UpsertUserInput {
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
  getBySubject(subject: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord[]>;
  list(): Promise<UserRecord[]>;
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
}

interface UserRow {
  id: string;
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
  'id, subject, email, display_name, status, created_at, last_login_at, removed_at, sessions_ended_at';

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
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
  const upsert = db.prepare<[string, string, string, string | null, string, string]>(
    `INSERT INTO users (id, subject, email, display_name, status, created_at, last_login_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT (subject) DO UPDATE SET
       email = excluded.email,
       display_name = excluded.display_name,
       last_login_at = excluded.last_login_at`,
  );
  const bySubject = db.prepare<[string], UserRow>(`SELECT ${COLUMNS} FROM users WHERE subject = ?`);
  const byEmail = db.prepare<[string], UserRow>(
    `SELECT ${COLUMNS} FROM users WHERE email = ? ORDER BY created_at`,
  );
  const all = db.prepare<[], UserRow>(`SELECT ${COLUMNS} FROM users ORDER BY created_at`);
  const remove = db.prepare<[string, string, string]>(
    `UPDATE users SET status = 'removed', removed_at = ?, sessions_ended_at = ? WHERE id = ?`,
  );
  const restore = db.prepare<[string]>(
    `UPDATE users SET status = 'active', removed_at = NULL WHERE id = ? AND status = 'removed'`,
  );

  return {
    async upsertFromIdp(input) {
      const now = nowIso(ctx);
      upsert.run(ctx.newId(), input.subject, input.email, input.displayName ?? null, now, now);
      return toRecord(requireRow(bySubject.get(input.subject), 'user', input.subject));
    },
    async getById(id) {
      const row = getUserRow(ctx, id);
      return row ? toRecord(row) : null;
    },
    async getBySubject(subject) {
      const row = bySubject.get(subject);
      return row ? toRecord(row) : null;
    },
    async findByEmail(email) {
      return byEmail.all(email).map(toRecord);
    },
    async list() {
      return all.all().map(toRecord);
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
