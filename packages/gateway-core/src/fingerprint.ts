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
 * One hash everywhere: the audit entry's `arguments_hash`, the approval requests, the
 * approvals and the `approval-required` refusal all carry this value, so an operator
 * can join an audit row to the request it produced.
 *
 * **What the fingerprint cannot tell apart.** Canonical JSON writes `null` for a
 * number JSON has no text for (`Infinity`, `-Infinity`, `NaN`), so `{"n": Infinity}`
 * and `{"n": null}` share a fingerprint — and `JSON.parse('{"n":1e999}')` does yield
 * `Infinity`. An approval read by a human as `null` would then be consumable by a
 * call carrying `Infinity`, which a plugin may treat differently (`args.n ?? 10`).
 * The pipeline therefore rejects such a call before anything else looks at it
 * (`unfaithfulArgument`): what is fingerprinted, sealed for the approver and handed
 * to the plugin is always a value JSON carries as is. `-0` and `0` also share a
 * fingerprint; JSON carries both as `0` to the service, and the difference is not
 * observable to a plugin short of `Object.is`: accepted.
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

/** A value of the arguments that JSON does not carry as is, and where it sits. */
export interface UnfaithfulArgument {
  /** `non-finite-number`: JSON writes it `null`. `bigint`: JSON has no form for it. */
  readonly kind: 'non-finite-number' | 'bigint';
  /** `a.b[2]`; `(arguments)` for the arguments as a whole. */
  readonly path: string;
  /** What it is, safe to show: `Infinity`, `-Infinity`, `NaN`, `a BigInt`. Never the arguments. */
  readonly value: string;
}

const WHOLE = '(arguments)';

/**
 * The first value in `args` whose JSON form is not the value: a non-finite number
 * (written `null`) or a BigInt (no form at all). `null` when there is none. Functions,
 * symbols and `undefined` are not reported: they are dropped, as `JSON.stringify`
 * drops them, and nothing reads them back as something else.
 */
export function unfaithfulArgument(args: unknown, path = ''): UnfaithfulArgument | null {
  if (typeof args === 'number') {
    return Number.isFinite(args)
      ? null
      : { kind: 'non-finite-number', path: path || WHOLE, value: String(args) };
  }
  if (typeof args === 'bigint') return { kind: 'bigint', path: path || WHOLE, value: 'a BigInt' };
  if (typeof args !== 'object' || args === null) return null;
  if (Array.isArray(args)) {
    for (const [index, item] of args.entries()) {
      const found = unfaithfulArgument(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, member] of Object.entries(args)) {
    const found = unfaithfulArgument(member, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
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
