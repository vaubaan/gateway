/**
 * A member's own token, issued for the first time or replaced — the one
 * implementation behind the two ways a person gets a token of their own on a
 * mission (spec §7.8, §7.9 bis):
 *
 *   - the creator's "Rotate token"            `MissionService.rotate`
 *   - "Generate my token" / "Rotate my token"  `MissionTeamService.generateToken`,
 *     which a member uses, and the creator may use as well.
 *
 * Both are the same act on the same row, so they are written once: the token
 * is minted and stored (the holder's previous active token becomes
 * `rotated`), the administrative entry says `mission-token-issued` for a
 * first token and `mission-rotated` for a replacement, and the session
 * records a `rotation` event. The callers keep what differs: who may ask, and
 * what is handed back.
 */
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import type { TokenMinter } from './token';
import { issueTokenTo, type IssuedSecret } from './token-issuer';

export interface MemberTokenDeps {
  readonly store: Pick<Store, 'missions' | 'sessions' | 'auditWriter'>;
  readonly mint: TokenMinter;
  readonly clock: Clock;
}

export interface MemberTokenInput {
  readonly missionId: string;
  /** The member the token is for, who is also the one asking: nobody mints for someone else. */
  readonly userId: string;
  /** The client behind the act when it comes through the management door. */
  readonly delegatedClientId: string | null;
}

/**
 * Throws `TokenNotIssuableError` when the store refuses the insert (the mission was
 * revoked, the member removed or deactivated, while the token was being minted): the
 * caller answers what its own read of the mission says then.
 */
export async function reissueMemberToken(
  deps: MemberTokenDeps,
  input: MemberTokenInput,
): Promise<IssuedSecret> {
  const { missionId, userId, delegatedClientId } = input;
  const issued = await issueTokenTo(
    { missions: deps.store.missions, mint: deps.mint },
    { missionId, holder: { kind: 'member', userId }, createdBy: userId },
  );
  const previous = issued.replaced;
  await deps.store.auditWriter.write({
    kind: 'admin',
    ts: toIso(deps.clock.now()),
    user_id: userId,
    // A first token is issued; a replacement is a rotation.
    act: previous ? 'mission-rotated' : 'mission-token-issued',
    object: { type: 'mission', id: missionId },
    before: previous ? { token_prefix: previous.prefix } : null,
    after: { token_prefix: issued.prefix, token_kind: 'member', holder: userId },
    delegated_client_id: delegatedClientId,
  });
  const session = await deps.store.sessions.getByMission(missionId);
  if (session) {
    await deps.store.sessions.recordEvent(session.id, {
      kind: 'rotation',
      details: {
        token_prefix: issued.prefix,
        token_kind: 'member',
        holder: userId,
        replaced_prefix: previous?.prefix ?? null,
      },
      actorUserId: userId,
    });
  }
  return issued;
}
