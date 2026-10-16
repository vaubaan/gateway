/**
 * The operator's bootstrap token (spec §0 "Operator", §4.3, §7.1).
 *
 * Comes from the mounted configuration (`bootstrap_token`, required while no
 * IdP is configured there). It opens `/admin` and nothing else, and is marked
 * revoked in `instance_config` (`bootstrap.revoked_at`) after the first
 * successful IdP sign-in of a user matching the admin rule — from then on the
 * operator is whoever the admin rule says, and the token is refused even if
 * it is still present in the configuration.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { systemClock, toIso, type Clock } from '../store/clock';
import type { ConfigRepo } from '../store/repositories/config';

export const BOOTSTRAP_REVOKED_KEY = 'bootstrap.revoked_at';
/** How many wrong tokens were presented since the instance started counting. */
export const BOOTSTRAP_MISSES_KEY = 'bootstrap.misses';
/**
 * Wrong tokens after which the token is revoked for good (security review
 * 2026-10-15, auth M1 B): it is a one-time install secret, and a token that
 * is being guessed is not one any more. The operator then signs in through a
 * provider set in the configuration (handbook authentication).
 */
export const BOOTSTRAP_MAX_MISSES = 50;

export type BootstrapState =
  /** No token in the configuration: the IdP is set there and bootstrap never applies. */
  | { readonly status: 'unavailable' }
  | { readonly status: 'active' }
  | { readonly status: 'revoked'; readonly revokedAt: string };

export class BootstrapService {
  constructor(
    private readonly token: string | null,
    private readonly config: ConfigRepo,
    private readonly clock: Clock = systemClock,
  ) {}

  async state(): Promise<BootstrapState> {
    if (this.token === null) return { status: 'unavailable' };
    const revokedAt = await this.config.get(BOOTSTRAP_REVOKED_KEY);
    return revokedAt ? { status: 'revoked', revokedAt } : { status: 'active' };
  }

  /** Constant-time comparison; false when absent or revoked. */
  async verify(presented: string): Promise<boolean> {
    if (this.token === null || presented.length === 0) return false;
    if ((await this.state()).status !== 'active') return false;
    return timingSafeEqual(digest(presented), digest(this.token));
  }

  /**
   * Counts one wrong token; at `BOOTSTRAP_MAX_MISSES` the token is revoked. Returns
   * whether this miss revoked it. The count is durable (`instance_config`), so a
   * restart does not reset it.
   */
  async recordMiss(): Promise<boolean> {
    if ((await this.state()).status !== 'active') return false;
    const misses = Number((await this.config.get(BOOTSTRAP_MISSES_KEY)) ?? '0') + 1;
    await this.config.set(BOOTSTRAP_MISSES_KEY, String(misses));
    if (misses < BOOTSTRAP_MAX_MISSES) return false;
    await this.revoke();
    return true;
  }

  /** Idempotent: a second revocation keeps the first timestamp. */
  async revoke(): Promise<BootstrapState> {
    const current = await this.state();
    if (current.status !== 'active') return current;
    const revokedAt = toIso(this.clock.now());
    await this.config.set(BOOTSTRAP_REVOKED_KEY, revokedAt);
    return { status: 'revoked', revokedAt };
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
