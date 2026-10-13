import { withImmediateTransaction } from '../db.ts';
import { NotFoundError } from '../errors.ts';
import type { GroupRecord, GroupSource, UserRecord } from '../types.ts';
import { nowIso, parseEnum, placeholders, requireRow, type RepoContext } from './context.ts';
import { GROUP_SOURCES } from './enums.ts';
import { userColumns, userRowToRecord, type UserRow } from './users.ts';

export interface GroupsRepo {
  getOrCreate(name: string, source: GroupSource): Promise<GroupRecord>;
  /**
   * Creates a local group (operator-kept). Returns `null` when the name is already held,
   * by a local group or by one the IdP claimed: a name designates one group.
   */
  createLocal(name: string): Promise<GroupRecord | null>;
  getById(id: string): Promise<GroupRecord | null>;
  getByName(name: string): Promise<GroupRecord | null>;
  list(): Promise<GroupRecord[]>;
  /** Replaces the membership atomically (IdP claim sync at login, or operator edit). */
  setMembers(groupId: string, userIds: readonly string[]): Promise<void>;
  /**
   * Replaces the user's memberships of IdP-sourced groups with `names`, in one
   * transaction: groups that do not exist yet are created (source `idp`), the
   * memberships the list no longer names are removed, and a failure leaves
   * everything as it was. Local groups are never touched: a name held by a
   * local group is skipped and returned in `skipped`.
   */
  syncIdpMemberships(userId: string, names: readonly string[]): Promise<{ skipped: string[] }>;
  /** Idempotent. `true` when the membership was added, `false` when it already existed. */
  addMember(groupId: string, userId: string): Promise<boolean>;
  removeMember(groupId: string, userId: string): Promise<boolean>;
  /**
   * Removes the user from every group, local and IdP-sourced, in one transaction, and
   * returns the groups they were in. The deactivation of a user: a group must not keep
   * counting as owned by somebody who holds nothing any more.
   */
  removeAllMemberships(userId: string): Promise<GroupRecord[]>;
  listMembers(groupId: string): Promise<UserRecord[]>;
  memberCount(groupId: string): Promise<number>;
  /** Groups the user currently belongs to — authority is recomputed from this, never cached. */
  groupsOf(userId: string): Promise<GroupRecord[]>;
}

interface GroupRow {
  id: string;
  name: string;
  source: string;
  created_at: string;
}

const COLUMNS = 'id, name, source, created_at';
const USER_COLUMNS = userColumns('u');

function toRecord(row: GroupRow): GroupRecord {
  return {
    id: row.id,
    name: row.name,
    source: parseEnum(GROUP_SOURCES, row.source, 'groups.source'),
    createdAt: row.created_at,
  };
}

export function createGroupsRepo(ctx: RepoContext): GroupsRepo {
  const { db } = ctx;
  const byId = db.prepare<[string], GroupRow>(`SELECT ${COLUMNS} FROM groups WHERE id = ?`);
  const byName = db.prepare<[string], GroupRow>(`SELECT ${COLUMNS} FROM groups WHERE name = ?`);
  const all = db.prepare<[], GroupRow>(`SELECT ${COLUMNS} FROM groups ORDER BY name`);
  // Creation is one statement, so two sign-ins claiming the same new group cannot collide.
  const insertIfAbsent = db.prepare<[string, string, string, string]>(
    `INSERT INTO groups (id, name, source, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO NOTHING`,
  );
  const addMemberStmt = db.prepare<[string, string, string]>(
    `INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)
     ON CONFLICT (group_id, user_id) DO NOTHING`,
  );
  const removeMemberStmt = db.prepare<[string, string]>(
    'DELETE FROM group_members WHERE group_id = ? AND user_id = ?',
  );
  const members = db.prepare<[string], UserRow>(
    `SELECT ${USER_COLUMNS} FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ? ORDER BY u.email`,
  );
  const count = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?',
  );
  const ofUser = db.prepare<[string], GroupRow>(
    `SELECT g.id, g.name, g.source, g.created_at FROM group_members gm
     JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ? ORDER BY g.name`,
  );

  function requireGroup(id: string): GroupRecord {
    const row = byId.get(id);
    if (!row) throw new NotFoundError('group', id);
    return toRecord(row);
  }

  function getOrCreateSync(name: string, source: GroupSource, now: string): GroupRecord {
    insertIfAbsent.run(ctx.newId(), name, source, now);
    return toRecord(requireRow(byName.get(name), 'group', name));
  }

  return {
    async getOrCreate(name, source) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => getOrCreateSync(name, source, now));
    },
    async createLocal(name) {
      const id = ctx.newId();
      const created = insertIfAbsent.run(id, name, 'local', nowIso(ctx)).changes > 0;
      return created ? requireGroup(id) : null;
    },
    async syncIdpMemberships(userId, names) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const skipped: string[] = [];
        const kept: string[] = [];
        for (const name of new Set(names)) {
          const group = getOrCreateSync(name, 'idp', now);
          if (group.source !== 'idp') {
            skipped.push(name);
            continue;
          }
          addMemberStmt.run(group.id, userId, now);
          kept.push(group.id);
        }
        const stale = kept.length > 0 ? ` AND group_id NOT IN (${placeholders(kept.length)})` : '';
        db.prepare<string[]>(
          `DELETE FROM group_members WHERE user_id = ?
             AND group_id IN (SELECT id FROM groups WHERE source = 'idp')${stale}`,
        ).run(userId, ...kept);
        return { skipped };
      });
    },
    async getById(id) {
      const row = byId.get(id);
      return row ? toRecord(row) : null;
    },
    async getByName(name) {
      const row = byName.get(name);
      return row ? toRecord(row) : null;
    },
    async list() {
      return all.all().map(toRecord);
    },
    async setMembers(groupId, userIds) {
      requireGroup(groupId);
      const now = nowIso(ctx);
      withImmediateTransaction(db, () => {
        if (userIds.length === 0) {
          db.prepare<[string]>('DELETE FROM group_members WHERE group_id = ?').run(groupId);
        } else {
          db.prepare<string[]>(
            `DELETE FROM group_members WHERE group_id = ? AND user_id NOT IN (${placeholders(userIds.length)})`,
          ).run(groupId, ...userIds);
        }
        for (const userId of userIds) addMemberStmt.run(groupId, userId, now);
      });
    },
    async addMember(groupId, userId) {
      requireGroup(groupId);
      return addMemberStmt.run(groupId, userId, nowIso(ctx)).changes > 0;
    },
    async removeMember(groupId, userId) {
      return removeMemberStmt.run(groupId, userId).changes > 0;
    },
    async removeAllMemberships(userId) {
      return withImmediateTransaction(db, () => {
        const left = ofUser.all(userId).map(toRecord);
        db.prepare<[string]>('DELETE FROM group_members WHERE user_id = ?').run(userId);
        return left;
      });
    },
    async listMembers(groupId) {
      return members.all(groupId).map(userRowToRecord);
    },
    async memberCount(groupId) {
      return count.get(groupId)?.n ?? 0;
    },
    async groupsOf(userId) {
      return ofUser.all(userId).map(toRecord);
    },
  };
}
