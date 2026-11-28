/**
 * The creator's token rotated, and what a presented token is worth (spec §0 "Mission
 * token", §7.8). The mission service delegates both here; a member's own token and the
 * other holders' are the `MissionTeamService`'s (`team-service.ts`).
 */
import type { TokenHolder } from '@vaubaan/gateway-core';

import type { Subject } from '../authority';
import { TokenNotIssuableError } from '../store/errors';
import { isOnMission } from '../store/membership';
import type { MissionRecord, MissionTokenRecord, UserRecord } from '../store/types';
import { bearerMatches, mintMissionToken, prefixOfBearer, type TokenMinter } from './token';
import { reissueMemberToken } from './member-token';
import type { IssuedSecret } from './token-issuer';
import type { MissionLookups } from './mission-lookups';
import type {
  MissionServiceDeps,
  IssueOptions,
  RotateResult,
  VerifiedToken,
  TokenVerification,
} from './mission-views';

/**
 * The holder of a token as the door and the audit name it. A member is shown
 * by their email; a member whose user row is gone keeps their id.
 */
export function tokenHolderOf(
  token: Pick<MissionTokenRecord, 'holder'>,
  user: Pick<UserRecord, 'email'> | null,
): TokenHolder {
  if (token.holder.kind === 'named') return { kind: 'named', name: token.holder.name };
  return {
    kind: 'member',
    user_id: token.holder.userId,
    display: user?.email ?? token.holder.userId,
  };
}

export class MissionTokens {
  private readonly mint: TokenMinter;

  constructor(
    private readonly deps: MissionServiceDeps,
    private readonly lookups: MissionLookups,
  ) {
    this.mint = deps.mint ?? mintMissionToken;
  }

  /**
   * A new token for the creator, same mission, same mission log, same budget
   * (spec §7.8): the creator's previous token stops working; every other
   * holder's token is untouched. A member rotates their own token through
   * `MissionTeamService.generateToken`, which the creator may use as well.
   *
   * Through the `vaubaan` plugin (`options.issuedBy`) only a mission that very
   * mission issued is rotated: the new token is handed to the caller, so
   * rotating a mission the human issued — wider, perhaps with a gate they
   * opened — would hand an agent an authority nobody issued to it
   * (docs/spec/vaubaan-gateway.md §6). The human rotates any of their missions
   * in the interface.
   */
  async rotate(
    user: Subject,
    missionId: string,
    options: IssueOptions = {},
  ): Promise<RotateResult> {
    const mission = await this.lookups.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    if (options.issuedBy && mission.issuedByMissionId !== options.issuedBy.missionId) {
      return { ok: false, reason: 'not-issued-by-mission' };
    }
    const state = await this.lookups.stateOf(mission);
    if (state.kind !== 'active') return { ok: false, reason: 'inactive', state: state.kind };

    let token: IssuedSecret;
    try {
      // The one implementation of "a member's own token, issued or replaced"
      // (`member-token.ts`), shared with `MissionTeamService.generateToken`.
      token = await reissueMemberToken(
        { store: this.deps.store, mint: this.mint, clock: this.deps.clock },
        {
          missionId: mission.id,
          userId: user.id,
          viaMissionId: options.issuedBy?.missionId ?? null,
        },
      );
    } catch (err) {
      // Revoked while the hash was computed: the store refused the insert.
      if (!(err instanceof TokenNotIssuableError)) throw err;
      return {
        ok: false,
        reason: 'inactive',
        state: await this.lookups.stateAfterRefusal(mission.id),
      };
    }
    this.deps.logger.info('mission token rotated', {
      mission_id: mission.id,
      token_prefix: token.prefix,
      issued_by_mission_id: options.issuedBy?.missionId ?? null,
    });
    return {
      ok: true,
      mission,
      token: { secret: token.secret, prefix: token.prefix },
      kit: await this.lookups.kitOf(mission, { secret: token.secret }),
    };
  }

  /**
   * Resolves a presented Bearer: prefix lookup, the comparison with the stored
   * SHA-256 digest, then what the token is worth at this instant
   * (`standingOf`). A malformed Bearer, an unknown prefix and a wrong secret
   * are the same answer (`unknown`).
   */
  async verifyToken(bearer: string): Promise<TokenVerification> {
    const prefix = prefixOfBearer(bearer);
    if (!prefix) return { outcome: 'unknown' };
    const found = await this.deps.store.missions.findTokenByPrefix(prefix);
    if (!found) return { outcome: 'unknown' };
    if (!bearerMatches(found.token, bearer)) return { outcome: 'unknown' };
    return this.standingOf(found);
  }

  /**
   * The one place that says whether a token whose secret matched authenticates
   * (spec §0 "Mission token"), read from the store on every call:
   *
   *   - a member token must belong to someone who is, right now, an active user
   *     and a current member of the mission. Nothing is cached and nothing needs
   *     to have been written: a member removed, or a user deactivated, a
   *     millisecond ago is refused;
   *   - the row must be `active` (a holder's rotation and any revocation retire it).
   *
   * The creator is a member by construction and has no row. Their deactivation
   * is not judged here: the mission then reads `orphaned` (derived by
   * `MissionGrounds`), every holder is refused `mission-inactive`, and the
   * same tokens serve again if the creator is reactivated.
   *
   * The record (and its hash) stops here: the door gets the id, the prefix and
   * the holder.
   */
  private async standingOf(found: {
    readonly token: MissionTokenRecord;
    readonly mission: MissionRecord;
  }): Promise<TokenVerification> {
    const { mission } = found;
    const record = found.token;
    const user =
      record.holder.kind === 'member'
        ? await this.deps.store.users.getById(record.holder.userId)
        : null;
    const token: VerifiedToken = {
      id: record.id,
      prefix: record.prefix,
      holder: tokenHolderOf(record, user),
    };
    // The holder is judged first: a member who was removed is told so whatever
    // became of their token or of the mission since (they are no longer told the
    // mission's state). The membership rule is the one `access` reads.
    if (record.holder.kind === 'member') {
      const membership = await this.lookups.membershipOf(mission, record.holder.userId, user);
      if (membership === 'deactivated') {
        return { outcome: 'retired', reason: 'holder-deactivated', mission, token };
      }
      if (!isOnMission(membership)) {
        return { outcome: 'retired', reason: 'holder-removed', mission, token };
      }
    }
    if (record.status !== 'active') {
      return { outcome: 'retired', reason: record.status, mission, token };
    }
    return { outcome: 'verified', mission, token };
  }
}
