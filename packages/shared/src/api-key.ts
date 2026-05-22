/**
 * API key generation / hashing for Bots.
 *
 * Format : `vbn_live_<8-char prefix>_<32-char base62 secret>`.
 * Hash   : argon2id with OWASP-2023 recommended params (19 MiB, 2 iters).
 *
 * Spec : docs/spec/mcp-proxy.md §3.1, §6.2.
 * ADR  : docs/decisions/api-key-format-vbn-live-argon2id.md.
 */

import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

const PREFIX_LIVE = 'vbn_live_';
const PREFIX_TEST = 'vbn_test_';
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

export type ApiKeyKind = 'live' | 'test';

export interface GeneratedApiKey {
  apiKey: string;
  apiKeyPrefix: string;
}

export function generateApiKey(kind: ApiKeyKind = 'live'): GeneratedApiKey {
  const envPrefix = kind === 'live' ? PREFIX_LIVE : PREFIX_TEST;
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
