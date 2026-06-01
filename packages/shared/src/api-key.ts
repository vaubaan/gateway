/**
 * API key generation / hashing.
 *
 * Three flavours share the same shape `vbn_<kind>_<8-char prefix>_<32-char base62 secret>`:
 *   - `live` : AccessToken (project-scoped, consumed at the MCP gateway).
 *   - `test` : Test AccessToken (same role, separate prefix for safety in fixtures).
 *   - `mgmt` : Org Management Key (org-scoped, used to mint AccessTokens
 *              programmatically via POST /api/v1/mgmt/tokens — never accepted
 *              at the MCP gateway).
 *
 * Hash : argon2id with OWASP-2023 recommended params (19 MiB, 2 iters).
 *
 * Spec : docs/spec/vaubaan-gateway.md §3.1, §6.2.
 * ADRs :
 *   - docs/decisions/api-key-format-vbn-live-argon2id.md
 *   - docs/decisions/programmatic-access-token-minting.md
 */

import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

const PREFIX_LIVE = 'vbn_live_';
const PREFIX_TEST = 'vbn_test_';
const PREFIX_MGMT = 'vbn_mgmt_';
const PREFIX_LEN = 8;
const SECRET_LEN = 32;
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

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

export type ApiKeyKind = 'live' | 'test' | 'mgmt';

const ENV_PREFIX: Record<ApiKeyKind, string> = {
  live: PREFIX_LIVE,
  test: PREFIX_TEST,
  mgmt: PREFIX_MGMT,
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
  } else if (raw.startsWith(PREFIX_MGMT)) {
    kind = 'mgmt';
    body = raw.slice(PREFIX_MGMT.length);
  } else {
    return null;
  }
  const underscore = body.indexOf('_');
  if (underscore !== PREFIX_LEN) return null;
  const prefix = body.slice(0, PREFIX_LEN);
  const secret = body.slice(PREFIX_LEN + 1);
  if (!/^[A-Za-z0-9]+$/.test(prefix) || secret.length !== SECRET_LEN) return null;
  return { kind, prefix, full: raw };
}

export async function hashApiKey(apiKey: string): Promise<string> {
  return argon2.hash(apiKey, ARGON2_OPTS);
}

export async function verifyApiKey(hash: string, apiKey: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, apiKey);
  } catch {
    return false;
  }
}
