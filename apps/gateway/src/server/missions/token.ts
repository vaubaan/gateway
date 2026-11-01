/**
 * Mission token mint — `vbn_live_<8-char prefix>_<32-char secret>`, stored as
 * the SHA-256 digest of the whole token, clear prefix for lookup (ADR
 * mission-token-sha256-digest). The secret leaves this module once, in the
 * return value of `mintMissionToken()`; only the prefix and the digest are
 * persisted. A row naming any other algorithm matches nothing: the
 * argon2id rows of earlier builds were revoked by migration 0028.
 */
import { apiKeyMatchesDigest, digestApiKey, generateApiKey, parseApiKey } from '@vaubaan/shared';

/** What every token is stored as. */
export const MISSION_TOKEN_HASH_ALG = 'sha256';

export interface MintedToken {
  /** The Bearer, revealed once. Never logged, never persisted. */
  readonly secret: string;
  readonly prefix: string;
  readonly hash: string;
  readonly hashAlg: typeof MISSION_TOKEN_HASH_ALG;
}

export type TokenMinter = () => Promise<MintedToken>;

export const mintMissionToken: TokenMinter = async () => {
  const { apiKey, apiKeyPrefix } = generateApiKey('live');
  return {
    secret: apiKey,
    prefix: apiKeyPrefix,
    hash: digestApiKey(apiKey),
    hashAlg: MISSION_TOKEN_HASH_ALG,
  };
};

/** The lookup prefix of a presented Bearer, or `null` when it is not a live mission token. */
export function prefixOfBearer(bearer: string): string | null {
  const parsed = parseApiKey(bearer.trim());
  if (!parsed || parsed.kind !== 'live') return null;
  return parsed.prefix;
}

/** The stored proof of a token: the value and the algorithm that produced it. */
export interface StoredTokenHash {
  readonly hash: string;
  readonly hashAlg: string;
}

/**
 * Does the presented Bearer match the stored row? The SHA-256 digest, compared in
 * constant time; a row naming any other algorithm matches nothing.
 */
export function bearerMatches(stored: StoredTokenHash, bearer: string): boolean {
  if (stored.hashAlg !== MISSION_TOKEN_HASH_ALG) return false;
  return apiKeyMatchesDigest(stored.hash, bearer.trim());
}

/** What a revisited page shows instead of the secret. */
export function maskedToken(prefix: string): string {
  return `vbn_live_${prefix}_…`;
}
