/**
 * Verified-token cache — argon2 once per token, not once per call.
 *
 * Spec §6 ("mission tokens are logged by prefix"), plan §3.3 ("prefix lookup →
 * argon2id verify → cached mission context"). Verifying a mission token costs
 * one argon2id hash (tens of milliseconds, by design). An agent calls the door
 * many times a minute with the same bearer, so the door remembers, behind
 * `CacheClient`, that a given bearer matched a given token row.
 *
 * What is cached is the PROOF, never the state: the key is the SHA-256 of the
 * bearer (the bearer itself is never a key, never logged) and the value is the
 * id of the token row whose hash it matched. On a hit the token and its
 * mission are re-read from the store by prefix, so a rotation or a revocation
 * takes effect on the very next call — the cache can only skip a hash
 * computation whose result cannot change (a token's hash is immutable).
 *
 * A miss on a known prefix is throttled per prefix before the hash is
 * computed, so a client replaying wrong secrets for a real prefix cannot make
 * the instance spend its CPU on argon2.
 */
import { createHash } from 'node:crypto';

import type { CacheClient } from '@vaubaan/gateway-core';

import type { RateLimiter } from '../compose/ports';
import { prefixOfBearer, type MissionService, type TokenVerification } from '../missions';
import type { MissionsRepo } from '../store';

/** How long a proof is kept. The proof never becomes false; the bound only limits memory. */
export const VERIFIED_TOKEN_TTL_SECONDS = 15 * 60;
/** Hash verifications allowed per token prefix per window, cache misses only. */
export const VERIFY_ATTEMPTS_PER_WINDOW = 30;
export const VERIFY_WINDOW_MS = 60_000;

const CACHE_KEY_PREFIX = 'mission-token:';

export type VerifyOutcome =
  | TokenVerification
  /** Too many hash verifications for this prefix; nothing was computed. */
  | { readonly outcome: 'throttled'; readonly retryAfterMs: number };

export interface TokenVerifierDeps {
  readonly missions: Pick<MissionService, 'verifyToken'>;
  readonly tokens: Pick<MissionsRepo, 'findTokenByPrefix'>;
  readonly cache: CacheClient;
  readonly rateLimiter: RateLimiter;
  readonly ttlSeconds?: number;
}

export function verifiedTokenCacheKey(bearer: string): string {
  return CACHE_KEY_PREFIX + createHash('sha256').update(bearer.trim()).digest('hex');
}

export class TokenVerifier {
  // single-process only — collapses concurrent first calls of one bearer into one
  // argon2 computation. Replicas of a hosted deployment each verify once; the shared
  // `CacheClient` then serves all of them.
  private readonly inFlight = new Map<string, Promise<VerifyOutcome>>();
  private readonly ttlSeconds: number;

  constructor(private readonly deps: TokenVerifierDeps) {
    this.ttlSeconds = deps.ttlSeconds ?? VERIFIED_TOKEN_TTL_SECONDS;
  }

  async verify(bearer: string): Promise<VerifyOutcome> {
    const prefix = prefixOfBearer(bearer);
    if (!prefix) return { outcome: 'unknown' };
    const key = verifiedTokenCacheKey(bearer);

    const provenTokenId = await this.deps.cache.get<string>(key);
    if (provenTokenId) {
      const found = await this.deps.tokens.findTokenByPrefix(prefix);
      if (found && found.token.id === provenTokenId) return stateOf(found);
      // The row is gone or the prefix now names another token: the proof is void.
      await this.deps.cache.del(key);
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const verification = this.verifyOnce(bearer, prefix, key).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, verification);
    return verification;
  }

  private async verifyOnce(bearer: string, prefix: string, key: string): Promise<VerifyOutcome> {
    const attempt = await this.deps.rateLimiter.take(
      `mcp-verify:${prefix}`,
      VERIFY_ATTEMPTS_PER_WINDOW,
      VERIFY_WINDOW_MS,
    );
    if (!attempt.allowed) return { outcome: 'throttled', retryAfterMs: attempt.retryAfterMs };
    const result = await this.deps.missions.verifyToken(bearer);
    if (result.outcome !== 'unknown') {
      await this.deps.cache.set(key, result.token.id, this.ttlSeconds);
    }
    return result;
  }
}

function stateOf(found: NonNullable<Awaited<ReturnType<MissionsRepo['findTokenByPrefix']>>>) {
  const { token, mission } = found;
  if (token.status === 'active') return { outcome: 'verified', token, mission } as const;
  return { outcome: 'retired', reason: token.status, token, mission } as const;
}
