/**
 * Mission token mint — `vbn_live_<8-char prefix>_<32-char secret>`, stored as
 * the SHA-256 digest of the whole token, clear prefix for lookup (ADR
 * mission-token-sha256-digest). The secret leaves this module once, in the
 * return value of `mintMissionToken()`; only the prefix and the digest are
 * persisted.
 *
 * A row written by an earlier build holds an argon2id hash instead
 * (`hash_alg = 'argon2id'`). `bearerMatches` still checks it, so a token issued
 * then keeps working; the mission service replaces the stored value by the
 * digest on the first call that matches (`MissionService.verifyToken`).
 */
import {
  apiKeyMatchesDigest,
  digestApiKey,
  generateApiKey,
  parseApiKey,
  verifyApiKeyArgon2id,
} from '@vaubaan/shared';

/** What every token is stored as from now on. */
export const MISSION_TOKEN_HASH_ALG = 'sha256';
/** What tokens were stored as before; read, never written. */
export const LEGACY_TOKEN_HASH_ALG = 'argon2id';

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

/** Is this row still stored the way an earlier build wrote it? */
export function isLegacyTokenHash(stored: StoredTokenHash): boolean {
  return stored.hashAlg === LEGACY_TOKEN_HASH_ALG;
}

/**
 * Does the presented Bearer match the stored row? Decided by the row's own
 * algorithm: the SHA-256 digest in constant time, argon2id for a row of an
 * earlier build. A row naming any other algorithm matches nothing.
 */
export async function bearerMatches(stored: StoredTokenHash, bearer: string): Promise<boolean> {
  const presented = bearer.trim();
  if (stored.hashAlg === MISSION_TOKEN_HASH_ALG) return apiKeyMatchesDigest(stored.hash, presented);
  if (isLegacyTokenHash(stored)) return verifyApiKeyArgon2id(stored.hash, presented);
  return false;
}

/** The digest that replaces a legacy hash once the Bearer has matched it. */
export function digestOfBearer(bearer: string): StoredTokenHash {
  return { hash: digestApiKey(bearer.trim()), hashAlg: MISSION_TOKEN_HASH_ALG };
}

/** What a revisited page shows instead of the secret. */
export function maskedToken(prefix: string): string {
  return `vbn_live_${prefix}_…`;
}
