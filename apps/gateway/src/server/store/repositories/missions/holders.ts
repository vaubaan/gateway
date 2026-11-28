import { withImmediateTransaction } from '../../db.ts';
import { InvariantError, TokenNotIssuableError } from '../../errors.ts';
import { isOnMission, membershipOf } from '../../membership.ts';
import { USER_STATUSES, type MissionTokenRecord } from '../../types.ts';
import { nowIso, parseEnum, requireRow, type RepoContext } from '../context.ts';
import type { MissionCore } from './core.ts';
import {
  MEMBER_COLUMNS,
  MS_PER_SECOND,
  TOKEN_COLUMNS,
  memberToRecord,
  tokenToRecord,
  type MemberRow,
  type TokenRow,
} from './rows.ts';
import type { MissionsRepo } from './types.ts';

export function createMissionHolders(
  ctx: RepoContext,
  core: MissionCore,
): Pick<
  MissionsRepo,
  | 'issueToken'
  | 'findTokenByPrefix'
  | 'listTokens'
  | 'getToken'
  | 'revokeTokens'
  | 'revokeToken'
  | 'revokeMemberTokensOf'
  | 'markTokenUsed'
  | 'addMember'
  | 'removeMember'
  | 'getMember'
  | 'listMembers'
> {
  const { db } = ctx;
  const { requireMission } = core;
  // Rotation retires the token of ONE holder: the other holders keep working.
  const activeOfMember = db.prepare<[string, string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens
     WHERE mission_id = ? AND holder_user_id = ? AND kind = 'member' AND status = 'active'`,
  );
  const activeOfName = db.prepare<[string, string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens
     WHERE mission_id = ? AND name = ? AND kind = 'named' AND status = 'active'`,
  );
  const retireOne = db.prepare<[string, string]>(
    `UPDATE mission_tokens SET status = 'rotated', retired_at = ? WHERE id = ? AND status = 'active'`,
  );
  const insertToken = db.prepare<
    [string, string, string, string, string, string, string | null, string | null, string, string]
  >(
    `INSERT INTO mission_tokens (id, mission_id, prefix, hash, hash_alg, status, kind,
       holder_user_id, name, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  );
  const tokenById = db.prepare<[string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens WHERE id = ?`,
  );
  const tokenByPrefix = db.prepare<[string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens WHERE prefix = ?`,
  );
  const tokensOf = db.prepare<[string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens WHERE mission_id = ? ORDER BY created_at`,
  );
  const revokeTokensStmt = db.prepare<[string, string]>(
    `UPDATE mission_tokens SET status = 'revoked', retired_at = ? WHERE mission_id = ? AND status = 'active'`,
  );
  const revokeOne = db.prepare<[string, string]>(
    `UPDATE mission_tokens SET status = 'revoked', retired_at = ? WHERE id = ? AND status = 'active'`,
  );
  const tokenOfMission = db.prepare<[string, string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens WHERE mission_id = ? AND id = ?`,
  );
  const revokeOneOfMission = db.prepare<[string, string, string]>(
    `UPDATE mission_tokens SET status = 'revoked', retired_at = ?
     WHERE mission_id = ? AND id = ? AND status = 'active'`,
  );
  const activeHeldAsMember = db.prepare<[string, string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens
     WHERE holder_user_id = ? AND kind = 'member' AND status = 'active'
       AND mission_id NOT IN (SELECT id FROM missions WHERE creator_user_id = ?)
     ORDER BY created_at`,
  );
  // Written only when the stored instant is older than the granularity: one statement,
  // so two concurrent calls write once.
  const markUsed = db.prepare<[string, string, string, string]>(
    `UPDATE mission_tokens SET last_used_at = ?
     WHERE mission_id = ? AND id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
  );
  const memberOf = db.prepare<[string, string], MemberRow>(
    `SELECT ${MEMBER_COLUMNS} FROM mission_members WHERE mission_id = ? AND user_id = ?`,
  );
  const membersOf = db.prepare<[string], MemberRow>(
    `SELECT ${MEMBER_COLUMNS} FROM mission_members
     WHERE mission_id = ? AND removed_at IS NULL ORDER BY added_at, user_id`,
  );
  const upsertMember = db.prepare<[string, string, string, string]>(
    `INSERT INTO mission_members (mission_id, user_id, added_by, added_at, removed_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (mission_id, user_id)
     DO UPDATE SET added_by = excluded.added_by, added_at = excluded.added_at, removed_at = NULL`,
  );
  const markMemberRemoved = db.prepare<[string, string, string]>(
    `UPDATE mission_members SET removed_at = ?
     WHERE mission_id = ? AND user_id = ? AND removed_at IS NULL`,
  );

  const userStatus = db.prepare<[string], { status: string }>(
    'SELECT status FROM users WHERE id = ?',
  );
  /** The status of a user, as the membership rule reads it; `null` for an unknown user. */
  function userStatusOf(userId: string): { status: 'active' | 'removed' } | null {
    const row = userStatus.get(userId);
    return row ? { status: parseEnum(USER_STATUSES, row.status, 'users.status') } : null;
  }

  function requireToken(id: string): MissionTokenRecord {
    return tokenToRecord(requireRow(tokenById.get(id), 'mission_token', id));
  }

  return {
    async issueToken(input) {
      const id = ctx.newId();
      const now = nowIso(ctx);
      const { holder } = input;
      const replacedId = withImmediateTransaction(db, () => {
        const mission = requireMission(input.missionId);
        // The caller checked all of this before it computed the hash, which takes
        // tens of milliseconds: a revocation, a removal or a deactivation committed
        // meanwhile must not be undone by the insert. Checked again here, in the
        // transaction that writes.
        if (mission.status !== 'active') {
          throw new TokenNotIssuableError('mission-not-active', input.missionId);
        }
        let previous: TokenRow | undefined;
        if (holder.kind === 'member') {
          const row = memberOf.get(input.missionId, holder.userId);
          const membership = membershipOf(
            mission,
            holder.userId,
            userStatusOf(holder.userId),
            row ? { removedAt: row.removed_at } : null,
          );
          if (!isOnMission(membership)) {
            throw new TokenNotIssuableError('holder-not-a-member', input.missionId);
          }
          previous = activeOfMember.get(input.missionId, holder.userId);
          if (previous) retireOne.run(now, previous.id);
        } else if (input.replacing !== undefined) {
          const old = tokenById.get(input.replacing);
          if (
            !old ||
            old.mission_id !== input.missionId ||
            old.kind !== 'named' ||
            old.status !== 'active' ||
            old.name !== holder.name
          ) {
            throw new TokenNotIssuableError('token-not-replaceable', input.missionId);
          }
          retireOne.run(now, old.id);
          previous = old;
        } else if (activeOfName.get(input.missionId, holder.name)) {
          throw new TokenNotIssuableError('name-taken', input.missionId);
        }
        insertToken.run(
          id,
          input.missionId,
          input.prefix,
          input.hash,
          input.hashAlg,
          holder.kind,
          holder.kind === 'member' ? holder.userId : null,
          holder.kind === 'named' ? holder.name : null,
          input.createdBy,
          now,
        );
        return previous?.id ?? null;
      });
      return {
        token: requireToken(id),
        replaced: replacedId === null ? null : requireToken(replacedId),
      };
    },
    async findTokenByPrefix(prefix) {
      const row = tokenByPrefix.get(prefix);
      if (!row) return null;
      return { token: tokenToRecord(row), mission: requireMission(row.mission_id) };
    },
    async listTokens(missionId) {
      return tokensOf.all(missionId).map(tokenToRecord);
    },
    async getToken({ missionId, tokenId }) {
      const row = tokenOfMission.get(missionId, tokenId);
      return row ? tokenToRecord(row) : null;
    },
    async revokeTokens(missionId) {
      return revokeTokensStmt.run(nowIso(ctx), missionId).changes;
    },
    async revokeToken({ missionId, tokenId }) {
      const changed = revokeOneOfMission.run(nowIso(ctx), missionId, tokenId).changes;
      return changed === 1 ? requireToken(tokenId) : null;
    },
    async revokeMemberTokensOf(userId) {
      const now = nowIso(ctx);
      const ids = withImmediateTransaction(db, () => {
        const held = activeHeldAsMember.all(userId, userId);
        return held.filter((row) => revokeOne.run(now, row.id).changes === 1).map((row) => row.id);
      });
      return ids.map(requireToken);
    },
    async markTokenUsed({ missionId, tokenId }, granularitySeconds) {
      const stale = new Date(ctx.clock.now().getTime() - granularitySeconds * MS_PER_SECOND);
      return markUsed.run(nowIso(ctx), missionId, tokenId, stale.toISOString()).changes === 1;
    },
    async addMember(input) {
      const now = nowIso(ctx);
      const staleId = withImmediateTransaction(db, () => {
        const mission = requireMission(input.missionId);
        if (mission.creatorUserId === input.userId) {
          throw new InvariantError('the creator is a member by construction, never a member row');
        }
        // A member starts with no token. A working row found here predates this
        // membership (it should not exist: removal revokes, and `issueToken` refuses
        // a holder who is not on the mission): it is revoked with the same write.
        const stale = activeOfMember.get(input.missionId, input.userId);
        if (stale) revokeOne.run(now, stale.id);
        upsertMember.run(input.missionId, input.userId, input.addedBy, now);
        return stale?.id ?? null;
      });
      return {
        member: memberToRecord(
          requireRow(memberOf.get(input.missionId, input.userId), 'mission_member', input.userId),
        ),
        tokenRevoked: staleId === null ? null : requireToken(staleId),
      };
    },
    async removeMember(missionId, userId) {
      const now = nowIso(ctx);
      const revokedId = withImmediateTransaction(db, () => {
        if (markMemberRemoved.run(now, missionId, userId).changes === 0) return undefined;
        const held = activeOfMember.get(missionId, userId);
        if (!held) return null;
        revokeOne.run(now, held.id);
        return held.id;
      });
      if (revokedId === undefined) return null;
      return {
        member: memberToRecord(
          requireRow(memberOf.get(missionId, userId), 'mission_member', userId),
        ),
        tokenRevoked: revokedId === null ? null : requireToken(revokedId),
      };
    },
    async getMember(missionId, userId) {
      const row = memberOf.get(missionId, userId);
      return row ? memberToRecord(row) : null;
    },
    async listMembers(missionId) {
      return membersOf.all(missionId).map(memberToRecord);
    },
  };
}
