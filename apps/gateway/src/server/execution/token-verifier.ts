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
 *
 * One exception, and it empties itself: a token issued by an earlier build is
 * stored as an argon2id hash, which costs tens of milliseconds to check. That
 * check is throttled, per token prefix AND client address, so a client
 * replaying wrong secrets for such a prefix cannot make the instance spend its
 * CPU. The prefix is not a secret (logs, session events, the Missions pages),
 * hence the address in the key: a window keyed on the prefix alone would let
 * whoever read one keep the real agent at 429. The first call that matches
 * moves the row to the digest (`MissionService.verifyToken`), after which the
 * token never meets the throttle again. Once every such row has been used or
 * retired, the throttle is dead code and can go with the argon2 dependency.
 */
import type { RateLimiter } from '../compose/ports';
import { UNKNOWN_CLIENT } from '../http/client-ip';
import {
  prefixOfBearer,
  type LegacyHashThrottled,
  type MissionService,
  type TokenVerification,
} from '../missions';

/** argon2id verifications allowed per legacy token prefix and client address per window. */
export const VERIFY_ATTEMPTS_PER_WINDOW = 30;
export const VERIFY_WINDOW_MS = 60_000;

export type VerifyOutcome =
  | TokenVerification
  /** Too many argon2id verifications for this legacy prefix from this address; nothing was computed. */
  | LegacyHashThrottled;

export interface TokenVerifierDeps {
  readonly missions: Pick<MissionService, 'verifyToken'>;
  /** Bounds the argon2id check of tokens stored by an earlier build; unused otherwise. */
  readonly rateLimiter: RateLimiter;
}

/** The throttle window of one legacy token prefix as seen from one client address. */
export function verifyThrottleKey(prefix: string, clientIp: string): string {
  return `mcp-verify:${prefix}:${clientIp}`;
}

export class TokenVerifier {
  constructor(private readonly deps: TokenVerifierDeps) {}

  /**
   * `clientIp` is the caller's address as the trusted-proxy rule resolves it
   * (`clientIpOf`), `UNKNOWN_CLIENT` when it cannot be resolved: all such callers
   * then share one throttle window per legacy prefix.
   */
  async verify(bearer: string, clientIp: string = UNKNOWN_CLIENT): Promise<VerifyOutcome> {
    const prefix = prefixOfBearer(bearer);
    if (!prefix) return { outcome: 'unknown' };
    return this.deps.missions.verifyToken(bearer, () =>
      this.deps.rateLimiter.take(
        verifyThrottleKey(prefix, clientIp),
        VERIFY_ATTEMPTS_PER_WINDOW,
        VERIFY_WINDOW_MS,
      ),
    );
  }
}
