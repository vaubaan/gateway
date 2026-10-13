/**
 * API key generation / hashing — the mission token format.
 *
 * Two flavours share the same shape `vbn_<kind>_<8-char prefix>_<32-char base62 secret>`:
 *   - `live` : mission token, revealed once at issuance, presented as the
 *              Bearer on the execution surface (spec §0 "Mission token").
 *   - `test` : same role, separate prefix for safety in fixtures.
 *
 * At rest : the SHA-256 digest of the whole token (`digestApiKey`). The
 * secret is 32 characters drawn at random by this module, about 190 bits : a
 * digest of it cannot be searched, so a slow password hash protects nothing
 * and only costs CPU on every cold verification. The prefix is stored in
 * clear next to the digest so the gateway can look a token up before
 * comparing.
 *
 * argon2id stays for one purpose : checking a token that was issued while
 * tokens were stored that way (`verifyApiKeyArgon2id`). Nothing is written
 * with it any more outside tests.
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1, §6.
 * ADR  : docs/decisions/mission-token-sha256-digest.md, which supersedes the
 *        hash of docs/decisions/api-key-format-vbn-live-argon2id.md (the
 *        format is unchanged).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

const PREFIX_LIVE = 'vbn_live_';
const PREFIX_TEST = 'vbn_test_';
const PREFIX_LEN = 8;
const SECRET_LEN = 32;

/**
 * Shape of a token of either flavour, for finding tokens inside free text
 * (log redaction). Group 1 = flavour, group 2 = prefix. Not global : callers
 * that scan a whole text build `new RegExp(API_KEY_PATTERN.source, 'g')`.
 */
export const API_KEY_PATTERN = new RegExp(
  `vbn_(live|test)_([A-Za-z0-9]{${PREFIX_LEN}})_[A-Za-z0-9]{${SECRET_LEN}}`,
);
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** A whole string in the token alphabet (no `$` : it would accept a trailing newline). */
const BASE62_ONLY = /^[A-Za-z0-9]+(?![\s\S])/;

const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

function randomBase62(len: number): string {
  const buf = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    const byte = buf[i] ?? 0;
    out += BASE62[byte % 62] ?? '0';
  }
  return out;
}

export type ApiKeyKind = 'live' | 'test';

const ENV_PREFIX: Record<ApiKeyKind, string> = {
  live: PREFIX_LIVE,
  test: PREFIX_TEST,
};

export interface GeneratedApiKey {
  apiKey: string;
  apiKeyPrefix: string;
}

export function generateApiKey(kind: ApiKeyKind = 'live'): GeneratedApiKey {
  const envPrefix = ENV_PREFIX[kind];
  const prefix = randomBase62(PREFIX_LEN);
  const secret = randomBase62(SECRET_LEN);
  const apiKey = `${envPrefix}${prefix}_${secret}`;
  return { apiKey, apiKeyPrefix: prefix };
}

export interface ParsedApiKey {
  kind: ApiKeyKind;
  prefix: string;
  full: string;
}

export function parseApiKey(raw: string): ParsedApiKey | null {
  let kind: ApiKeyKind;
  let body: string;
  if (raw.startsWith(PREFIX_LIVE)) {
    kind = 'live';
    body = raw.slice(PREFIX_LIVE.length);
  } else if (raw.startsWith(PREFIX_TEST)) {
    kind = 'test';
    body = raw.slice(PREFIX_TEST.length);
  } else {
    return null;
  }
  const underscore = body.indexOf('_');
  if (underscore !== PREFIX_LEN) return null;
  const prefix = body.slice(0, PREFIX_LEN);
  const secret = body.slice(PREFIX_LEN + 1);
  if (!BASE62_ONLY.test(prefix) || secret.length !== SECRET_LEN || !BASE62_ONLY.test(secret)) {
    return null;
  }
  return { kind, prefix, full: raw };
}

/** The digest stored for a token : SHA-256 of the whole token, lowercase hex. */
export function digestApiKey(apiKey: string): string {
  return sha256(apiKey).toString('hex');
}

/**
 * Does `apiKey` hash to the stored `digest` ? Compared in constant time ; a
 * stored value that is not a SHA-256 in hex matches nothing.
 */
export function apiKeyMatchesDigest(digest: string, apiKey: string): boolean {
  if (!SHA256_HEX.test(digest)) return false;
  return timingSafeEqual(Buffer.from(digest, 'hex'), sha256(apiKey));
}

const SHA256_HEX = /^[0-9a-f]{64}(?![\s\S])/;

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/**
 * The argon2id hash tokens were stored as before the SHA-256 digest. Kept so
 * that tests can build such a row ; the gateway no longer writes one.
 */
export async function hashApiKeyArgon2id(apiKey: string): Promise<string> {
  return argon2.hash(apiKey, ARGON2_OPTS);
}

/** Checks a token against an argon2id hash stored by an earlier build. */
export async function verifyApiKeyArgon2id(hash: string, apiKey: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, apiKey);
  } catch {
    return false;
  }
}
