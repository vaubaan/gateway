/**
 * The administrators of the instance (migration 0020; ADR
 * administrators-live-in-the-instance): one designation per row — a user, a pending
 * address, or a group of a sign-in provider. Who decides is the auth module's
 * `AdministratorsService`; this is the table.
 */

import { withImmediateTransaction } from '../db.ts';
import { InvariantError } from '../errors.ts';
import type { Iso } from '../types.ts';
import { nowIso, parseEnum, type RepoContext } from './context.ts';

export const ADMINISTRATOR_KINDS = ['user', 'email', 'group'] as const;
export type AdministratorKind = (typeof ADMINISTRATOR_KINDS)[number];

export const ADMINISTRATOR_ORIGINS = ['setup', 'granted', 'configuration', 'recovered'] as const;
/** Why a designation exists: named by the setup, by an administrator, by the configuration's rule, by a recovery. */
export type AdministratorOrigin = (typeof ADMINISTRATOR_ORIGINS)[number];

interface DesignationBase {
  readonly id: string;
  /** A user id, or `bootstrap`, `configuration`, `recovery`. */
  readonly grantedBy: string;
  readonly origin: AdministratorOrigin;
  readonly createdAt: Iso;
}

/** One user, administrator until unmade. */
export interface UserDesignation extends DesignationBase {
  readonly kind: 'user';
  readonly userId: string;
}

/** An address waiting for its first sign-in, through one provider or any (`provider` null). */
export interface EmailDesignation extends DesignationBase {
  readonly kind: 'email';
  /** Lower-cased. */
  readonly email: string;
  readonly provider: string | null;
}

/** Every member a provider claims in this group; `provider` null: the only provider (a bare name). */
export interface GroupDesignation extends DesignationBase {
  readonly kind: 'group';
  readonly groupName: string;
  readonly provider: string | null;
}

export type Designation = UserDesignation | EmailDesignation | GroupDesignation;

export interface DesignationInput {
  readonly grantedBy: string;
  readonly origin: AdministratorOrigin;
}

export interface AdministratorsRepo {
  /** Oldest first. */
  list(): Promise<Designation[]>;
  count(): Promise<number>;
  get(id: string): Promise<Designation | null>;
  /** The user's row, or `null`. */
  ofUser(userId: string): Promise<UserDesignation | null>;
  /** `null` when the user already has one (the first is kept). */
  addUser(userId: string, input: DesignationInput): Promise<UserDesignation | null>;
  /** `null` when the same address is already pending for the same provider. */
  addEmail(
    email: string,
    provider: string | null,
    input: DesignationInput,
  ): Promise<EmailDesignation | null>;
  /** `null` when the same group of the same provider is already designated. */
  addGroup(
    groupName: string,
    provider: string | null,
    input: DesignationInput,
  ): Promise<GroupDesignation | null>;
  /** The removed row, or `null`. */
  remove(id: string): Promise<Designation | null>;
  /**
   * Turns the pending addresses that name `email` for `provider` (or for any provider)
   * into a `user` row for `userId`, in one transaction. Returns the consumed
   * designations (empty: nothing pending, or the user already administers).
   */
  consumeEmail(userId: string, email: string, provider: string): Promise<EmailDesignation[]>;
  /**
   * Writes several designations at once, all or none (the seed of the configuration's
   * rule). Duplicates are skipped.
   */
  addMany(
    users: readonly string[],
    emails: readonly { email: string; provider: string | null }[],
    groups: readonly { groupName: string; provider: string | null }[],
    input: DesignationInput,
  ): Promise<Designation[]>;
}

interface AdministratorRow {
  id: string;
  kind: string;
  user_id: string | null;
  email: string | null;
  provider: string | null;
  group_name: string | null;
  granted_by: string;
  origin: string;
  created_at: string;
}

const COLUMNS = 'id, kind, user_id, email, provider, group_name, granted_by, origin, created_at';

function toDesignation(row: AdministratorRow): Designation {
  const kind = parseEnum(ADMINISTRATOR_KINDS, row.kind, 'administrators.kind');
  const base = {
    id: row.id,
    grantedBy: row.granted_by,
    origin: parseEnum(ADMINISTRATOR_ORIGINS, row.origin, 'administrators.origin'),
    createdAt: row.created_at,
  };
  if (kind === 'user') {
    if (row.user_id === null) throw new InvariantError('a user designation names a user');
    return { ...base, kind, userId: row.user_id };
  }
  if (kind === 'email') {
    if (row.email === null) throw new InvariantError('an email designation names an address');
    return { ...base, kind, email: row.email, provider: row.provider };
  }
  if (row.group_name === null) throw new InvariantError('a group designation names a group');
  return { ...base, kind, groupName: row.group_name, provider: row.provider };
}

export function createAdministratorsRepo(ctx: RepoContext): AdministratorsRepo {
  const { db } = ctx;
  const all = db.prepare<[], AdministratorRow>(
    `SELECT ${COLUMNS} FROM administrators ORDER BY created_at, id`,
  );
  const countAll = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM administrators');
  const byId = db.prepare<[string], AdministratorRow>(
    `SELECT ${COLUMNS} FROM administrators WHERE id = ?`,
  );
  const byUser = db.prepare<[string], AdministratorRow>(
    `SELECT ${COLUMNS} FROM administrators WHERE kind = 'user' AND user_id = ?`,
  );
  const insert = db.prepare<
    [
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string,
      string,
      string,
    ]
  >(
    `INSERT INTO administrators (id, kind, user_id, email, provider, group_name, granted_by, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  );
  const remove = db.prepare<[string]>('DELETE FROM administrators WHERE id = ?');
  const pendingFor = db.prepare<[string, string], AdministratorRow>(
    `SELECT ${COLUMNS} FROM administrators
     WHERE kind = 'email' AND email = ? AND (provider IS NULL OR provider = ?)
     ORDER BY created_at, id`,
  );

  function insertRow(
    kind: AdministratorKind,
    fields: {
      userId?: string;
      email?: string;
      provider?: string | null;
      groupName?: string;
    },
    input: DesignationInput,
  ): Designation | null {
    const id = ctx.newId();
    const changes = insert.run(
      id,
      kind,
      fields.userId ?? null,
      fields.email ?? null,
      fields.provider ?? null,
      fields.groupName ?? null,
      input.grantedBy,
      input.origin,
      nowIso(ctx),
    ).changes;
    if (changes === 0) return null;
    const row = byId.get(id);
    return row ? toDesignation(row) : null;
  }

  const normalize = (email: string): string => email.trim().toLowerCase();

  return {
    async list() {
      return all.all().map(toDesignation);
    },
    async count() {
      return countAll.get()?.n ?? 0;
    },
    async get(id) {
      const row = byId.get(id);
      return row ? toDesignation(row) : null;
    },
    async ofUser(userId) {
      const row = byUser.get(userId);
      return row ? (toDesignation(row) as UserDesignation) : null;
    },
    async addUser(userId, input) {
      return insertRow('user', { userId }, input) as UserDesignation | null;
    },
    async addEmail(email, provider, input) {
      return insertRow(
        'email',
        { email: normalize(email), provider },
        input,
      ) as EmailDesignation | null;
    },
    async addGroup(groupName, provider, input) {
      return insertRow(
        'group',
        { groupName: groupName.trim(), provider },
        input,
      ) as GroupDesignation | null;
    },
    async remove(id) {
      const row = byId.get(id);
      if (!row) return null;
      return remove.run(id).changes > 0 ? toDesignation(row) : null;
    },
    async consumeEmail(userId, email, provider) {
      return withImmediateTransaction(db, () => {
        const pending = pendingFor.all(normalize(email), provider).map(toDesignation);
        if (pending.length === 0) return [];
        const first = pending[0];
        if (!byUser.get(userId) && first) {
          insertRow('user', { userId }, { grantedBy: first.grantedBy, origin: first.origin });
        }
        for (const designation of pending) remove.run(designation.id);
        return pending as EmailDesignation[];
      });
    },
    async addMany(users, emails, groups, input) {
      return withImmediateTransaction(db, () => {
        const out: Designation[] = [];
        for (const userId of users) {
          const row = insertRow('user', { userId }, input);
          if (row) out.push(row);
        }
        for (const { email, provider } of emails) {
          const row = insertRow('email', { email: normalize(email), provider }, input);
          if (row) out.push(row);
        }
        for (const { groupName, provider } of groups) {
          const row = insertRow('group', { groupName: groupName.trim(), provider }, input);
          if (row) out.push(row);
        }
        return out;
      });
    },
  };
}
