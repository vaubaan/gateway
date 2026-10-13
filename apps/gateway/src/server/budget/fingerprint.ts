/**
 * Canonical argument fingerprint — pure.
 *
 * Spec §3.5: an approval is bound to `(mission, RiskId, argument fingerprint)` and the
 * executor "replays the call identically... a call with different arguments, even by
 * one byte, asks again"; §6 "call arguments are never logged in clear, only hashed".
 *
 * The fingerprint is the SHA-256 (hex, 64 characters) of the canonical JSON of the
 * arguments: object keys sorted recursively, arrays kept in order, `undefined` members
 * dropped, no whitespace. Two argument objects that differ only by key order therefore
 * share a fingerprint, which is what an MCP client re-serializing a replay needs.
 *
 * Distinct from `@vaubaan/gateway-core`'s `hashArguments` (sha256 of
 * `JSON.stringify`, truncated to 16 hex characters, kept for v4-comparable audit rows):
 * that one is not canonical. Requests and approvals use this module.
 */

import { createHash } from 'node:crypto';

type JsonLike = { toJSON?: unknown };

function canonicalize(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value);
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'bigint':
      throw new TypeError('canonicalJson: BigInt values are not serializable');
    case 'object':
      break;
  }
  const withToJson = value as JsonLike;
  if (typeof withToJson.toJSON === 'function') {
    return canonicalize((withToJson.toJSON as () => unknown)());
  }
  if (Array.isArray(value)) {
    // JSON.stringify writes `null` for array members it cannot serialize.
    return `[${value.map((item) => canonicalize(item) ?? 'null').join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const member = canonicalize(record[key]);
    if (member !== undefined) members.push(`${JSON.stringify(key)}:${member}`);
  }
  return `{${members.join(',')}}`;
}

/** JSON text with recursively sorted object keys and no whitespace. */
export function canonicalJson(value: unknown): string {
  // A top-level `undefined` (or function) has no JSON form; like the fingerprint of
  // "no arguments", it is the empty object.
  return canonicalize(value) ?? '{}';
}

/** SHA-256 hex of `canonicalJson(args ?? {})`. */
export function fingerprintArguments(args: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(args ?? {}))
    .digest('hex');
}
