import { withImmediateTransaction } from '../db.ts';
import { NotFoundError } from '../errors.ts';
import type { GroupRecord, GroupSource, UserRecord } from '../types.ts';
import { nowIso, placeholders, type RepoContext } from './context.ts';
import { userColumns, userRowToRecord, type UserRow } from './users.ts';

export interface GroupsRepo {
  getOrCreate(name: string, source: GroupSource): Promise<GroupRecord>;
  getById(id: string): Promise<GroupRecord | null>;
  getByName(name: string): Promise<GroupRecord | null>;
  list(): Promise<GroupRecord[]>;
  /** Replaces the membership atomically (IdP claim sync at login, or operator edit). */
  setMembers(groupId: string, userIds: readonly string[]): Promise<void>;
  addMember(groupId: string, userId: string): Promise<void>;
  removeMember(groupId: string, userId: string): Promise<boolean>;
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
    source: row.source as GroupSource,
    createdAt: row.created_at,
  };
}

export function createGroupsRepo(ctx: RepoContext): GroupsRepo {
  const { db } = ctx;
  const byId = db.prepare<[string], GroupRow>(`SELECT ${COLUMNS} FROM groups WHERE id = ?`);
  const byName = db.prepare<[string], GroupRow>(`SELECT ${COLUMNS} FROM groups WHERE name = ?`);
  const all = db.prepare<[], GroupRow>(`SELECT ${COLUMNS} FROM groups ORDER BY name`);
  const insert = db.prepare<[string, string, string, string]>(
    'INSERT INTO groups (id, name, source, created_at) VALUES (?, ?, ?, ?)',
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

  return {
    async getOrCreate(name, source) {
      const existing = byName.get(name);
      if (existing) return toRecord(existing);
      const id = ctx.newId();
      insert.run(id, name, source, nowIso(ctx));
      return requireGroup(id);
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
      addMemberStmt.run(groupId, userId, nowIso(ctx));
    },
    async removeMember(groupId, userId) {
      return removeMemberStmt.run(groupId, userId).changes > 0;
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
