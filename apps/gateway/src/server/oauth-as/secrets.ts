/**
 * The secrets the authorization server mints: authorization codes, delegated
 * access tokens, refresh tokens, client ids and client secrets.
 *
 * Every secret is 32 random bytes (256 bits) in base64url, opaque: it carries
 * no claim and means nothing without its row. Only its SHA-256 is stored and
 * looked up (spec §6 "no secret in logs"; the same rule as web sessions): at
 * that entropy a plain digest is not guessable, so no slow hash is needed and
 * a copy of the database is not a set of live tokens.
 *
 * The prefixes make the kind recognisable — by a door that must refuse the
 * wrong kind without a lookup, and by a secret scanner — and are distinct from
 * the mission token's `vbn_live_`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET_BYTES = 32;
const CLIENT_ID_BYTES = 16;
/** base64url of 32 bytes, unpadded. */
const SECRET_BODY = '[A-Za-z0-9_-]{43}';

/** Delegated access token. */
export const ACCESS_TOKEN_PREFIX = 'vbn_dat_';
/** Delegated refresh token. */
export const REFRESH_TOKEN_PREFIX = 'vbn_drt_';
/** Secret of a confidential OAuth client. */
export const CLIENT_SECRET_PREFIX = 'vbn_dcs_';
/** Identifier of a dynamically registered client. Not a secret. */
export const CLIENT_ID_PREFIX = 'vbn_client_';

const ACCESS_TOKEN_SHAPE = new RegExp(`^${ACCESS_TOKEN_PREFIX}${SECRET_BODY}$`);
const REFRESH_TOKEN_SHAPE = new RegExp(`^${REFRESH_TOKEN_PREFIX}${SECRET_BODY}$`);
const CODE_SHAPE = new RegExp(`^${SECRET_BODY}$`);

function randomSecret(prefix: string): string {
  return prefix + randomBytes(SECRET_BYTES).toString('base64url');
}

export const mintAccessToken = (): string => randomSecret(ACCESS_TOKEN_PREFIX);
export const mintRefreshToken = (): string => randomSecret(REFRESH_TOKEN_PREFIX);
export const mintClientSecret = (): string => randomSecret(CLIENT_SECRET_PREFIX);
/** An authorization code travels in a redirect: no prefix, nothing but the random part. */
export const mintAuthorizationCode = (): string => randomSecret('');
export const mintClientId = (): string =>
  CLIENT_ID_PREFIX + randomBytes(CLIENT_ID_BYTES).toString('base64url');

/** Shape checks: a value of another shape is never hashed nor looked up. */
export const isAccessTokenShaped = (value: string): boolean => ACCESS_TOKEN_SHAPE.test(value);
export const isRefreshTokenShaped = (value: string): boolean => REFRESH_TOKEN_SHAPE.test(value);
export const isAuthorizationCodeShaped = (value: string): boolean => CODE_SHAPE.test(value);

/** The stored form of a secret: SHA-256, hex. */
export function digestOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Compares a presented secret with a stored digest in constant time. Both
 * sides are digests of the same length, so neither the length nor the
 * position of the first difference of the secret shows in the timing.
 */
export function matchesDigest(presented: string, storedDigest: string): boolean {
  const a = Buffer.from(digestOf(presented), 'hex');
  const b = Buffer.from(storedDigest, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
