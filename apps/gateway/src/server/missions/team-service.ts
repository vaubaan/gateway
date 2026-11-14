/**
 * `MissionTeamService` — the members of a mission and its tokens (spec §0
 * "Mission member", "Mission token"; §7.9 bis "Work on a mission as a team";
 * ADR mission-members-and-per-holder-tokens).
 *
 * A mission has one or more tokens, each with one holder, so that every call
 * through the execution door is attributed:
 *
 *   member token   a member generates it for themselves after signing in. Its
 *                  secret is returned to that member, once, and to nobody
 *                  else: the creator never sees it, and no method of this
 *                  service (nor any row of the store, which keeps a hash) can
 *                  give it back. The member rotates or revokes it; the creator
 *                  may revoke it, and removing the member revokes it.
 *   named token    the creator creates it for something that has no account (a
 *                  CI runner, a shared machine) and gives it a name. Its
 *                  secret is returned to the creator, once.
 *
 * Who may do what:
 *
 *   creator   add and remove members; create and replace named tokens; revoke
 *             any token; generate, rotate and revoke their own token. The
 *             creator cannot leave: stopping the mission is their act
 *   member    generate, rotate and revoke their OWN token; leave the mission
 *             (their token is revoked with it); read the mission and its team.
 *             Nothing else: they cannot change the mission, its gates or its
 *             members, nor answer its requests (`MissionService` and
 *             `RequestService` know the creator only)
 *
 * Every token of a mission shares its resources, its policy and its ONE
 * budget (spec §3.2): nothing here touches a counter. A member works under
 * the creator's authority and needs no share of the mission's connections
 * (spec §11.2 "Members and authority"): the derived `orphaned` rule keeps
 * looking at the creator alone, and adding a member checks no authority.
 *
 * "Does not exist", "not yours" and "not shared with you" are one answer
 * (`not-found`). An act the reader can see the mission for but may not perform
 * (a member adding a member) is `not-found` too: the page never offers it, and
 * the answer does not need to say more.
 */
import type { MissionTokenKind, SessionEventDetails } from '@vaubaan/shared';

import { findActiveUserByEmail } from '../authority/principals';
import type { Subject } from '../authority';
import type { MissionState } from '../budget';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { TokenNotIssuableError } from '../store/errors';
import { toIso, type Clock } from '../store/clock';
import type { MissionRecord, MissionTokenRecord, UserRecord } from '../store/types';
import type { BootstrapKit } from './bootstrap-kit';
import type { MissionAccess, MissionRole, MissionService, RevealedToken } from './mission-service';
import { mintMissionToken, type TokenMinter } from './token';
import { reissueMemberToken } from './member-token';
import { issueTokenTo, type IssuedSecret } from './token-issuer';
import { parseTokenName } from '../../lib/missions/token-name';

export interface MissionTeamDeps {
  readonly store: Pick<Store, 'missions' | 'users' | 'sessions' | 'auditWriter'>;
  /** Who may read a mission, its state at this instant, and its kit. */
  readonly missions: Pick<MissionService, 'access' | 'stateOf' | 'stateAfterRefusal' | 'kitOf'>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Tests inject a deterministic minter; production stores the SHA-256 digest. */
  readonly mint?: TokenMinter;
}

/** How a token holder is shown: an email for a member, the name for a named token. */
export interface TeamHolderView {
  readonly kind: MissionTokenKind;
  /** The member's user id; `null` for a named token. */
  readonly user_id: string | null;
  /** The member's email (their id when the user row is gone), or the token's name. */
  readonly label: string;
}

export interface TeamTokenView {
  readonly id: string;
  /** Public lookup prefix; the secret is never part of any view. */
  readonly prefix: string;
  readonly holder: TeamHolderView;
  readonly created_at: string;
  /** Who generated or created it (an email, or an id when the user row is gone). */
  readonly created_by: string;
  /** The last call the door authenticated with it, to the minute; `null`: never used. */
  readonly last_used_at: string | null;
  /** The reader holds this token. */
  readonly mine: boolean;
  /** The reader may revoke it: their own, or any token for the creator. */
  readonly revocable: boolean;
}

export interface TeamMemberView {
  readonly user_id: string;
  readonly email: string;
  readonly role: MissionRole;
  /** `null` for the creator, a member by construction. */
  readonly added_at: string | null;
  /** The member is an active user; a deactivated one stays listed until removed. */
  readonly active: boolean;
  /** Whether they hold a working token now. */
  readonly has_token: boolean;
}

export interface MissionTeam {
  readonly mission: { readonly id: string; readonly name: string };
  /** What the reader is to the mission. */
  readonly role: MissionRole;
  /** The creator first, then the members in the order they were added. */
  readonly members: readonly TeamMemberView[];
  /** The tokens that work now, oldest first. */
  readonly tokens: readonly TeamTokenView[];
  /** The reader's own working token, if they have one. */
  readonly my_token: TeamTokenView | null;
  /**
   * Whether tokens can be generated or created now: the mission serves calls.
   * (Revoking a token and removing a member stay possible on any mission.)
   */
  readonly issuable: boolean;
  /**
   * Active users the creator may add: everyone who signed in at least once and
   * is not on the mission yet. Empty for a member: only the creator adds.
   */
  readonly candidates: readonly { readonly id: string; readonly email: string }[];
}

type NotFound = { readonly ok: false; readonly reason: 'not-found' };
type Inactive = {
  readonly ok: false;
  readonly reason: 'inactive';
  readonly state: MissionState['kind'];
};

export type AddMemberResult =
  | { readonly ok: true; readonly member: TeamMemberView }
  | NotFound
  /** The mission is revoked: nobody can work on it any more. */
  | Inactive
  /** No active user of this instance has this email (or two do). */
  | { readonly ok: false; readonly reason: 'user-not-found' }
  | { readonly ok: false; readonly reason: 'already-member' };

export type RemoveMemberResult =
  | { readonly ok: true; readonly user_id: string; readonly token_revoked: boolean }
  | NotFound
  | { readonly ok: false; readonly reason: 'not-a-member' };

export type IssuedTokenResult =
  | {
      readonly ok: true;
      readonly mission: { readonly id: string; readonly name: string };
      readonly token: RevealedToken;
      readonly kit: BootstrapKit;
      /** The holder's previous token was replaced (a rotation), not a first token. */
      readonly rotated: boolean;
    }
  | NotFound
  | Inactive;

export type NamedTokenResult =
  | IssuedTokenResult
  | { readonly ok: false; readonly reason: 'invalid-name'; readonly problem: string }
  | { readonly ok: false; readonly reason: 'name-taken' };

export type ReplaceNamedTokenResult =
  | IssuedTokenResult
  /** Not a working machine key of this mission (a member's key, a revoked one…). */
  | { readonly ok: false; readonly reason: 'not-replaceable' };

export type LeaveResult =
  | { readonly ok: true; readonly token_revoked: boolean }
  | NotFound
  /** The creator is on the mission by construction: they stop it, they do not leave it. */
  | { readonly ok: false; readonly reason: 'creator-cannot-leave' };

export type RevokeTokenResult =
  { readonly ok: true; readonly token_id: string; readonly already: boolean } | NotFound;

/**
 * Why one token was revoked on its own, as the audit entry says it. `member-removed`
 * is the token of somebody who was not a member when it was found working (revoked
 * as they are added again); the token a removal revokes is recorded on the
 * `mission-member-removed` entry itself.
 */
type RevocationReason = 'by-holder' | 'by-creator' | 'member-removed' | 'holder-deactivated';

export class MissionTeamService {
  private readonly mint: TokenMinter;

  constructor(private readonly deps: MissionTeamDeps) {
    this.mint = deps.mint ?? mintMissionToken;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Read
  // ───────────────────────────────────────────────────────────────────────────

  /** The members and tokens of a mission, for its creator or one of its members. */
  async team(user: Subject, missionId: string): Promise<MissionTeam | null> {
    const access = await this.deps.missions.access(user, missionId);
    if (!access) return null;
    const { mission, role } = access;
    const { store } = this.deps;
    const users = new UserNames(store.users);
    const active = (await store.missions.listTokens(mission.id)).filter(
      (token) => token.status === 'active',
    );
    const tokens: TeamTokenView[] = [];
    for (const token of active) tokens.push(await tokenView(token, user.id, role, users));

    const holders = new Set(tokens.map((t) => t.holder.user_id));
    const rows = await store.missions.listMembers(mission.id);
    const creator = await users.get(mission.creatorUserId);
    const members: TeamMemberView[] = [
      {
        user_id: mission.creatorUserId,
        email: creator?.email ?? mission.creatorUserId,
        role: 'creator',
        added_at: null,
        active: creator?.status === 'active',
        has_token: holders.has(mission.creatorUserId),
      },
    ];
    for (const row of rows) {
      const member = await users.get(row.userId);
      members.push({
        user_id: row.userId,
        email: member?.email ?? row.userId,
        role: 'member',
        added_at: row.addedAt,
        active: member?.status === 'active',
        has_token: holders.has(row.userId),
      });
    }

    const state = await this.deps.missions.stateOf(mission);
    const onMission = new Set(members.map((m) => m.user_id));
    return {
      mission: { id: mission.id, name: mission.name },
      role,
      members,
      tokens,
      my_token: tokens.find((t) => t.mine) ?? null,
      issuable: state.kind === 'active',
      candidates:
        role === 'creator'
          ? (await store.users.list())
              .filter((u) => u.status === 'active' && !onMission.has(u.id))
              .map((u) => ({ id: u.id, email: u.email }))
              .sort((a, b) => a.email.localeCompare(b.email))
          : [],
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Members — the creator only
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Gives a user of the instance access to the mission. The target is named by
   * email and must be an active user (the instance knows only who signed in
   * once). No authority is checked on the member: they work under the
   * creator's (spec §11.2). They get no token here: they generate their own.
   */
  async addMember(
    user: Subject,
    missionId: string,
    target: { readonly email: string },
  ): Promise<AddMemberResult> {
    const mission = await this.creatorMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    // A revoked mission refuses every call for good: there is nothing to work on.
    if (mission.status === 'revoked') return { ok: false, reason: 'inactive', state: 'revoked' };
    const lookup = await findActiveUserByEmail(this.deps.store.users, target.email);
    if (!lookup.found) return { ok: false, reason: 'user-not-found' };
    const member = lookup.user;
    if (member.id === mission.creatorUserId) return { ok: false, reason: 'already-member' };
    const existing = await this.deps.store.missions.getMember(mission.id, member.id);
    if (existing && existing.removedAt === null) return { ok: false, reason: 'already-member' };

    const { member: added, tokenRevoked } = await this.deps.store.missions.addMember({
      missionId: mission.id,
      userId: member.id,
      addedBy: user.id,
    });
    await this.audit(user.id, 'mission-member-added', mission.id, null, {
      member_user_id: member.id,
      member_email: member.email,
    });
    // A member starts with no token: a working row that predated this membership was
    // revoked by the store with the same write, and is recorded like any revocation.
    if (tokenRevoked) {
      await this.auditRevocation(user.id, tokenRevoked, 'member-removed');
      await this.recordRevocation(mission.id, user.id, tokenRevoked);
    }
    this.deps.logger.info('mission member added', {
      mission_id: mission.id,
      member_user_id: member.id,
      actor_id: user.id,
    });
    return {
      ok: true,
      member: {
        user_id: member.id,
        email: member.email,
        role: 'member',
        added_at: added.addedAt,
        active: true,
        has_token: false,
      },
    };
  }

  /**
   * Removes a member. Their token, if they had one, is revoked in the same
   * store transaction: there is no instant at which a removed member holds a
   * working token (and the door checks membership on every call besides).
   */
  async removeMember(
    user: Subject,
    missionId: string,
    memberUserId: string,
  ): Promise<RemoveMemberResult> {
    const mission = await this.creatorMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    const removed = await this.deps.store.missions.removeMember(mission.id, memberUserId);
    if (!removed) return { ok: false, reason: 'not-a-member' };
    const member = await this.deps.store.users.getById(memberUserId);
    const revoked = removed.tokenRevoked;
    await this.audit(
      user.id,
      'mission-member-removed',
      mission.id,
      { member_user_id: memberUserId, member_email: member?.email ?? null },
      { token_revoked_prefix: revoked?.prefix ?? null },
    );
    if (revoked) await this.recordRevocation(mission.id, user.id, revoked);
    this.deps.logger.info('mission member removed', {
      mission_id: mission.id,
      member_user_id: memberUserId,
      actor_id: user.id,
      token_prefix: revoked?.prefix ?? null,
    });
    return { ok: true, user_id: memberUserId, token_revoked: revoked !== null };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tokens
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * "Generate my token" / "Rotate my token": a new member token for the caller
   * — the creator or a member — on a mission that serves calls. Their previous
   * token, if any, stops working at once; nobody else's token is touched. The
   * secret is in this result only, handed to the holder themselves.
   */
  async generateToken(user: Subject, missionId: string): Promise<IssuedTokenResult> {
    const access = await this.deps.missions.access(user, missionId);
    if (!access) return { ok: false, reason: 'not-found' };
    const { mission } = access;
    const state = await this.deps.missions.stateOf(mission);
    if (state.kind !== 'active') return { ok: false, reason: 'inactive', state: state.kind };

    let issued: IssuedSecret;
    try {
      // The one implementation of "a member's own token, issued or replaced"
      // (`member-token.ts`), shared with the creator's `MissionService.rotate`.
      issued = await reissueMemberToken(
        { store: this.deps.store, mint: this.mint, clock: this.deps.clock },
        { missionId: mission.id, userId: user.id, viaMissionId: null },
      );
    } catch (err) {
      // Removed, deactivated, or the mission revoked, while the hash was computed: the
      // store refused the insert, and the answer is what `access` would say now.
      if (!(err instanceof TokenNotIssuableError)) throw err;
      return this.notIssued(mission.id, err);
    }
    const previous = issued.replaced;
    this.deps.logger.info('mission member token generated', {
      mission_id: mission.id,
      holder_user_id: user.id,
      token_prefix: issued.prefix,
      rotated: previous !== null,
    });
    return this.revealed(mission, issued, previous !== null);
  }

  /**
   * A token for something that has no account, identified by the name the
   * creator gives it (spec §0). Creator only. The secret is in this result
   * only: the creator hands it to the machine. To replace it:
   * `replaceNamedToken`.
   */
  async createNamedToken(
    user: Subject,
    missionId: string,
    rawName: unknown,
  ): Promise<NamedTokenResult> {
    const mission = await this.creatorMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    const name = parseTokenName(rawName);
    if (!name.ok) return { ok: false, reason: 'invalid-name', problem: name.problem };
    const state = await this.deps.missions.stateOf(mission);
    if (state.kind !== 'active') return { ok: false, reason: 'inactive', state: state.kind };
    if (await this.activeNamed(mission.id, name.value)) return { ok: false, reason: 'name-taken' };

    let issued: IssuedSecret;
    try {
      issued = await issueTokenTo(
        { missions: this.deps.store.missions, mint: this.mint },
        {
          missionId: mission.id,
          holder: { kind: 'named', name: name.value },
          createdBy: user.id,
        },
      );
    } catch (err) {
      if (!(err instanceof TokenNotIssuableError)) throw err;
      // Two creations of one name at the same instant: the store kept one.
      if (err.reason === 'name-taken') return { ok: false, reason: 'name-taken' };
      return this.notIssued(mission.id, err);
    }
    await this.audit(user.id, 'mission-token-issued', mission.id, null, {
      token_prefix: issued.prefix,
      token_kind: 'named',
      holder: name.value,
    });
    await this.recordEvent(mission.id, user.id, {
      kind: 'rotation',
      details: {
        token_prefix: issued.prefix,
        token_kind: 'named',
        holder: name.value,
        replaced_prefix: null,
      },
    });
    this.deps.logger.info('mission named token created', {
      mission_id: mission.id,
      token_name: name.value,
      token_prefix: issued.prefix,
      actor_id: user.id,
    });
    return this.revealed(mission, issued, false);
  }

  /**
   * "Replace key" on a machine key (spec §7.8): the creator retires the named token
   * and receives a new one of the same name, in ONE store transaction — the old key
   * stops working at once, there is no instant at which the name is free, and no grace
   * period. One administrative entry (`mission-rotated`, the old prefix before, the
   * new one after) and one `rotation` event. Creator only.
   */
  async replaceNamedToken(
    user: Subject,
    missionId: string,
    tokenId: string,
  ): Promise<ReplaceNamedTokenResult> {
    const mission = await this.creatorMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    // A token of another mission reads as missing: the key carries the mission.
    const old = await this.deps.store.missions.getToken({ missionId: mission.id, tokenId });
    if (!old) return { ok: false, reason: 'not-found' };
    if (old.holder.kind !== 'named' || old.status !== 'active') {
      return { ok: false, reason: 'not-replaceable' };
    }
    const state = await this.deps.missions.stateOf(mission);
    if (state.kind !== 'active') return { ok: false, reason: 'inactive', state: state.kind };
    const name = old.holder.name;

    let issued: IssuedSecret;
    try {
      issued = await issueTokenTo(
        { missions: this.deps.store.missions, mint: this.mint },
        {
          missionId: mission.id,
          holder: { kind: 'named', name },
          createdBy: user.id,
          replacing: old.id,
        },
      );
    } catch (err) {
      if (!(err instanceof TokenNotIssuableError)) throw err;
      // Revoked or replaced meanwhile by another tab: nothing was written.
      if (err.reason === 'token-not-replaceable') return { ok: false, reason: 'not-replaceable' };
      return this.notIssued(mission.id, err);
    }
    await this.audit(
      user.id,
      'mission-rotated',
      mission.id,
      { token_prefix: old.prefix },
      { token_prefix: issued.prefix, token_kind: 'named', holder: name },
    );
    await this.recordEvent(mission.id, user.id, {
      kind: 'rotation',
      details: {
        token_prefix: issued.prefix,
        token_kind: 'named',
        holder: name,
        replaced_prefix: old.prefix,
      },
    });
    this.deps.logger.info('mission named token replaced', {
      mission_id: mission.id,
      token_name: name,
      token_prefix: issued.prefix,
      replaced_prefix: old.prefix,
      actor_id: user.id,
    });
    return this.revealed(mission, issued, true);
  }

  /**
   * A teammate leaves a mission by themselves (spec §7.9 bis): the same act as the
   * creator removing them — the membership ends and their working token is revoked
   * in one store transaction, so the token is refused from its next call with the
   * reason `holder-removed`, and they no longer read the mission. One administrative
   * entry (`mission-member-left`) and, when they held a key, a `revocation` event.
   * The creator cannot leave: they stop the mission instead.
   */
  async leave(user: Subject, missionId: string): Promise<LeaveResult> {
    const access = await this.deps.missions.access(user, missionId);
    if (!access) return { ok: false, reason: 'not-found' };
    if (access.role === 'creator') return { ok: false, reason: 'creator-cannot-leave' };
    const { mission } = access;
    const removed = await this.deps.store.missions.removeMember(mission.id, user.id);
    // Removed by the creator between the read and the write: the same end, already reached.
    if (!removed) return { ok: false, reason: 'not-found' };
    const revoked = removed.tokenRevoked;
    const member = await this.deps.store.users.getById(user.id);
    await this.audit(
      user.id,
      'mission-member-left',
      mission.id,
      { member_user_id: user.id, member_email: member?.email ?? null },
      { token_revoked_prefix: revoked?.prefix ?? null },
    );
    if (revoked) await this.recordRevocation(mission.id, user.id, revoked);
    this.deps.logger.info('mission member left', {
      mission_id: mission.id,
      member_user_id: user.id,
      token_prefix: revoked?.prefix ?? null,
    });
    return { ok: true, token_revoked: revoked !== null };
  }

  /**
   * Revokes one token on its own: the others keep working, the mission and its
   * budget are untouched (spec §7.9 bis). A member revokes their own token;
   * the creator revokes any. Idempotent: a token already retired is `already`.
   */
  async revokeToken(user: Subject, missionId: string, tokenId: string): Promise<RevokeTokenResult> {
    const access = await this.deps.missions.access(user, missionId);
    if (!access) return { ok: false, reason: 'not-found' };
    const { mission, role } = access;
    // A token of another mission reads as missing: same answer as an unknown id.
    const token = await this.deps.store.missions.getToken({ missionId: mission.id, tokenId });
    if (!token) return { ok: false, reason: 'not-found' };
    const own = token.holder.kind === 'member' && token.holder.userId === user.id;
    if (role !== 'creator' && !own) return { ok: false, reason: 'not-found' };

    const revoked = await this.deps.store.missions.revokeToken({
      missionId: mission.id,
      tokenId: token.id,
    });
    if (!revoked) return { ok: true, token_id: token.id, already: true };
    await this.auditRevocation(user.id, revoked, own ? 'by-holder' : 'by-creator');
    await this.recordRevocation(mission.id, user.id, revoked);
    this.deps.logger.info('mission token revoked', {
      mission_id: mission.id,
      token_prefix: revoked.prefix,
      token_kind: revoked.kind,
      actor_id: user.id,
    });
    return { ok: true, token_id: revoked.id, already: false };
  }

  /**
   * Called when an operator deactivates a user (`UserAdminService`): every
   * member token they hold on a mission they did not create is revoked, each
   * with its entry in the operator's name. The door refuses those tokens from
   * the deactivation itself (it reads the holder's status on every call); this
   * makes the end durable, so a reactivated user generates a new token instead
   * of finding an old Bearer working again. Their memberships stay. Returns
   * how many tokens were revoked.
   */
  async revokeTokensOfDeactivated(actorId: string, userId: string): Promise<number> {
    const revoked = await this.deps.store.missions.revokeMemberTokensOf(userId);
    for (const token of revoked) {
      await this.auditRevocation(actorId, token, 'holder-deactivated');
      // No session event: its actor column names a user, and the operator may be
      // the bootstrap operator. The administrative entry is the record.
    }
    if (revoked.length > 0) {
      this.deps.logger.warn('member tokens of a deactivated user revoked', {
        user_id: userId,
        actor_id: actorId,
        tokens_revoked: revoked.length,
      });
    }
    return revoked.length;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  /** What the caller is told when the store refused the insert (`TokenNotIssuableError`). */
  private async notIssued(
    missionId: string,
    refusal: TokenNotIssuableError,
  ): Promise<NotFound | Inactive> {
    if (refusal.reason !== 'mission-not-active') return { ok: false, reason: 'not-found' };
    return {
      ok: false,
      reason: 'inactive',
      state: await this.deps.missions.stateAfterRefusal(missionId),
    };
  }

  /** The mission when `user` created it; `null` for anyone else, a member included. */
  private async creatorMission(
    user: Subject,
    missionId: string,
  ): Promise<MissionAccess['mission'] | null> {
    const access = await this.deps.missions.access(user, missionId);
    return access?.role === 'creator' ? access.mission : null;
  }

  private async activeNamed(missionId: string, name: string): Promise<boolean> {
    const tokens = await this.deps.store.missions.listTokens(missionId);
    return tokens.some(
      (t) => t.status === 'active' && t.holder.kind === 'named' && t.holder.name === name,
    );
  }

  private async revealed(
    mission: MissionRecord,
    issued: { readonly secret: string; readonly prefix: string },
    rotated: boolean,
  ): Promise<IssuedTokenResult> {
    return {
      ok: true,
      mission: { id: mission.id, name: mission.name },
      token: { secret: issued.secret, prefix: issued.prefix },
      kit: await this.deps.missions.kitOf(mission, { secret: issued.secret }),
      rotated,
    };
  }

  private async audit(
    actorId: string,
    act:
      | 'mission-member-added'
      | 'mission-member-removed'
      | 'mission-member-left'
      | 'mission-token-issued'
      | 'mission-rotated'
      | 'mission-token-revoked',
    missionId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: actorId,
      act,
      object: { type: 'mission', id: missionId },
      before,
      after,
    });
  }

  private auditRevocation(
    actorId: string,
    token: MissionTokenRecord,
    reason: RevocationReason,
  ): Promise<void> {
    return this.audit(
      actorId,
      'mission-token-revoked',
      token.missionId,
      { token_prefix: token.prefix, token_kind: token.kind, holder: holderKey(token) },
      { status: 'revoked', reason },
    );
  }

  private recordRevocation(
    missionId: string,
    actorUserId: string,
    token: MissionTokenRecord,
  ): Promise<void> {
    return this.recordEvent(missionId, actorUserId, {
      kind: 'revocation',
      details: {
        tokens_revoked: 1,
        token_prefix: token.prefix,
        token_kind: token.kind,
        holder: holderKey(token),
      },
    });
  }

  /** Session events exist only once the session does (born on the first call). */
  private async recordEvent(
    missionId: string,
    actorUserId: string,
    event: Extract<SessionEventDetails, { kind: 'rotation' | 'revocation' }>,
  ): Promise<void> {
    const session = await this.deps.store.sessions.getByMission(missionId);
    if (!session) return;
    await this.deps.store.sessions.recordEvent(session.id, { ...event, actorUserId });
  }
}

/** The holder as the audit and the session keep it: a user id, or the token's name. */
function holderKey(token: Pick<MissionTokenRecord, 'holder'>): string {
  return token.holder.kind === 'member' ? token.holder.userId : token.holder.name;
}

/** Users behind the ids of one view, read once each. */
class UserNames {
  private readonly cache = new Map<string, UserRecord | null>();

  constructor(private readonly users: Pick<Store['users'], 'getById'>) {}

  async get(id: string): Promise<UserRecord | null> {
    if (!this.cache.has(id)) this.cache.set(id, await this.users.getById(id));
    return this.cache.get(id) ?? null;
  }

  async label(id: string): Promise<string> {
    return (await this.get(id))?.email ?? id;
  }
}

async function tokenView(
  token: MissionTokenRecord,
  readerId: string,
  role: MissionRole,
  users: UserNames,
): Promise<TeamTokenView> {
  const mine = token.holder.kind === 'member' && token.holder.userId === readerId;
  return {
    id: token.id,
    prefix: token.prefix,
    holder:
      token.holder.kind === 'member'
        ? {
            kind: 'member',
            user_id: token.holder.userId,
            label: await users.label(token.holder.userId),
          }
        : { kind: 'named', user_id: null, label: token.holder.name },
    created_at: token.createdAt,
    created_by: await users.label(token.createdBy),
    last_used_at: token.lastUsedAt,
    mine,
    revocable: mine || role === 'creator',
  };
}
