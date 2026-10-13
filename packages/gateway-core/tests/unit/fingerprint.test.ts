/**
 * Canonical argument fingerprint (spec §3.5: an approval is bound to the exact argument
 * fingerprint; a replay must match byte for byte in canonical form; spec §6: call
 * arguments are never logged in clear, only hashed).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { canonicalJson, fingerprintArguments } from '../../src/index.ts';

describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('drops undefined members like JSON.stringify, writes null for array holes', () => {
    expect(canonicalJson({ a: undefined, b: null, c: [undefined, 1] })).toBe(
      '{"b":null,"c":[null,1]}',
    );
  });

  it('honours toJSON (dates) and serializes primitives as JSON', () => {
    expect(canonicalJson(new Date('2026-10-13T00:00:00.000Z'))).toBe('"2026-10-13T00:00:00.000Z"');
    expect(canonicalJson('é"')).toBe('"é\\""');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(NaN)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(undefined)).toBe('{}');
  });

  it('refuses BigInt like JSON does', () => {
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
  });
});

describe('fingerprintArguments', () => {
  it('is sha256 hex (64 chars) of the canonical JSON', () => {
    const args = { repo: 'acme/app', pr: 42 };
    const expected = createHash('sha256').update('{"pr":42,"repo":"acme/app"}').digest('hex');
    expect(fingerprintArguments(args)).toBe(expected);
    expect(fingerprintArguments(args)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores key order but not the smallest value change', () => {
    const a = fingerprintArguments({ repo: 'acme/app', pr: 42, opts: { squash: true, x: 1 } });
    const b = fingerprintArguments({ opts: { x: 1, squash: true }, pr: 42, repo: 'acme/app' });
    const c = fingerprintArguments({ repo: 'acme/app', pr: 43, opts: { squash: true, x: 1 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('treats no arguments as the empty object', () => {
    expect(fingerprintArguments(undefined)).toBe(fingerprintArguments({}));
    expect(fingerprintArguments(null)).toBe(fingerprintArguments({}));
  });

  it('is what the audit entry carries: 64 hex characters, insensitive to key order', () => {
    expect(fingerprintArguments({ b: 1, a: 2 })).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintArguments({ b: 1, a: 2 })).toBe(fingerprintArguments({ a: 2, b: 1 }));
  });
});
