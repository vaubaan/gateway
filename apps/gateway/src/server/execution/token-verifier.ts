/**
 * Mission-token verification at the execution door.
 *
 * Spec §6 ("mission tokens are logged by prefix", "only a digest is stored").
 * A mission token is stored as the SHA-256 digest of the Bearer (ADR
 * mission-token-sha256-digest). Verifying one is a lookup by prefix and a
 * constant-time comparison: there is nothing to cache and nothing to protect
 * from a flood, so every call asks the mission service, which reads the row,
 * its mission and — for a member token — the holder's status and membership
 * from the store. A rotation, a revocation, a member removed or a holder
 * deactivated takes effect on the very next call because nothing is remembered.
 */
import { prefixOfBearer, type MissionService, type TokenVerification } from '../missions';

export interface TokenVerifierDeps {
  readonly missions: Pick<MissionService, 'verifyToken'>;
}

export class TokenVerifier {
  constructor(private readonly deps: TokenVerifierDeps) {}

  async verify(bearer: string): Promise<TokenVerification> {
    if (!prefixOfBearer(bearer)) return { outcome: 'unknown' };
    return this.deps.missions.verifyToken(bearer);
  }
}
