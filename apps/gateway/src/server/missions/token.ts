/**
 * Mission token mint — `vbn_live_<8-char prefix>_<32-char secret>`, argon2id
 * hash, clear prefix for lookup (ADR api-key-format-vbn-live-argon2id, kept
 * through the v5 pivot). The secret leaves this module once, in the return
 * value of `mintMissionToken()`; only the prefix and the hash are persisted.
 */
import { generateApiKey, hashApiKey, parseApiKey, verifyApiKey } from '@vaubaan/shared';

export const MISSION_TOKEN_HASH_ALG = 'argon2id';

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
    hash: await hashApiKey(apiKey),
    hashAlg: MISSION_TOKEN_HASH_ALG,
  };
};

/** The lookup prefix of a presented Bearer, or `null` when it is not a live mission token. */
export function prefixOfBearer(bearer: string): string | null {
  const parsed = parseApiKey(bearer.trim());
  if (!parsed || parsed.kind !== 'live') return null;
  return parsed.prefix;
}

/** argon2id verification of a presented Bearer against a stored hash. */
export async function bearerMatches(hash: string, bearer: string): Promise<boolean> {
  return verifyApiKey(hash, bearer.trim());
}

/** What a revisited page shows instead of the secret. */
export function maskedToken(prefix: string): string {
  return `vbn_live_${prefix}_…`;
}
