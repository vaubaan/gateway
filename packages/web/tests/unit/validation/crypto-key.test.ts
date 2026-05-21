import { describe, it, expect } from 'vitest';

import {
  KDF_DEFAULT,
  parseCreateKey,
  parseKdfParams,
  parsePatch,
} from '../../../src/lib/validation/crypto-key';

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64');
const zeros = (n: number): string => b64(Array.from({ length: n }, () => 0));

const validCreateBody = {
  public_key: zeros(32),
  fingerprint: 'a'.repeat(32),
  wrapped_private_key: zeros(72),
  kdf_salt: zeros(16),
};

describe('parseKdfParams', () => {
  it('returns the spec defaults when input is undefined', () => {
    const r = parseKdfParams(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(KDF_DEFAULT);
  });

  it('rejects params weaker than spec floor', () => {
    const r = parseKdfParams({ m: 32 * 1024 * 1024, t: 3, p: 1, alg: 'argon2id' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('kdf_params_too_weak');
  });

  it('rejects non-argon2id alg', () => {
    const r = parseKdfParams({ m: 67_108_864, t: 3, p: 1, alg: 'scrypt' });
    expect(r.ok).toBe(false);
  });

  it('accepts stronger-than-default params', () => {
    const r = parseKdfParams({ m: 128 * 1024 * 1024, t: 4, p: 2, alg: 'argon2id' });
    expect(r.ok).toBe(true);
  });
});

describe('parseCreateKey', () => {
  it('accepts a well-formed payload', () => {
    const r = parseCreateKey(JSON.stringify(validCreateBody));
    expect(r.ok).toBe(true);
  });

  it('rejects public_key with wrong byte length', () => {
    const r = parseCreateKey(JSON.stringify({ ...validCreateBody, public_key: zeros(16) }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'invalid_field') expect(r.error.field).toBe('public_key');
  });

  it('rejects malformed fingerprint', () => {
    const r = parseCreateKey(
      JSON.stringify({ ...validCreateBody, fingerprint: 'NOT-HEX-XX'.padEnd(32, 'z') }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'invalid_field') expect(r.error.field).toBe('fingerprint');
  });

  it('rejects too-small wrapped_private_key', () => {
    const r = parseCreateKey(JSON.stringify({ ...validCreateBody, wrapped_private_key: zeros(8) }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'invalid_field')
      expect(r.error.field).toBe('wrapped_private_key');
  });

  it('rejects wrong-sized kdf_salt', () => {
    const r = parseCreateKey(JSON.stringify({ ...validCreateBody, kdf_salt: zeros(8) }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'invalid_field') expect(r.error.field).toBe('kdf_salt');
  });

  it('rejects invalid JSON', () => {
    const r = parseCreateKey('{not-json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_json');
  });
});

describe('parsePatch', () => {
  it('accepts a rotate-password payload (no pubkey/fingerprint)', () => {
    const r = parsePatch(
      JSON.stringify({
        wrapped_private_key: zeros(72),
        kdf_salt: zeros(16),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('rotate-password');
  });

  it('rejects rotate-password that smuggles a pubkey', () => {
    const r = parsePatch(
      JSON.stringify({
        public_key: zeros(32),
        wrapped_private_key: zeros(72),
        kdf_salt: zeros(16),
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('accepts a replace-identity payload', () => {
    const r = parsePatch(
      JSON.stringify({
        replace: true,
        public_key: zeros(32),
        fingerprint: 'b'.repeat(32),
        wrapped_private_key: zeros(72),
        kdf_salt: zeros(16),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('replace-identity');
  });

  it('rejects replace=true without a pubkey', () => {
    const r = parsePatch(
      JSON.stringify({
        replace: true,
        fingerprint: 'b'.repeat(32),
        wrapped_private_key: zeros(72),
        kdf_salt: zeros(16),
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects weak kdf_params', () => {
    const r = parsePatch(
      JSON.stringify({
        wrapped_private_key: zeros(72),
        kdf_salt: zeros(16),
        kdf_params: { m: 1024, t: 3, p: 1, alg: 'argon2id' },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('kdf_params_too_weak');
  });
});
