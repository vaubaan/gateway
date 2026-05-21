/**
 * Validation for /api/crm/v1/me/crypto-key payloads.
 *
 * Spec docs/spec/cloud-resource-manager.md §4.1 (keypair shape), §4.6
 * (password rotation), §4.7 (lost-password = identity replace). Schemas
 * are kept manual (no zod dep) — keeps the bundle lean and lets us
 * encode all length / regex / lower-bound checks in one place.
 *
 * Error messages never echo client cleartext: "kdf_params too weak"
 * rather than "m=12345 < 67108864". The HTTP layer surfaces these as
 * 400 with a stable `code` string.
 */

export const KDF_MIN_M = 67_108_864; // 64 MiB (spec §4.1)
export const KDF_MIN_T = 3;
export const KDF_MIN_P = 1;
export const KDF_ALG = 'argon2id' as const;
export const KDF_DEFAULT: KdfParamsInput = {
  m: KDF_MIN_M,
  t: KDF_MIN_T,
  p: KDF_MIN_P,
  alg: KDF_ALG,
};

export const PUBLIC_KEY_BYTES = 32;
export const KDF_SALT_BYTES = 16;
export const WRAPPED_SK_MIN_BYTES = 40;
export const WRAPPED_SK_MAX_BYTES = 200;
export const FINGERPRINT_REGEX = /^[0-9a-f]{32}$/;

export interface KdfParamsInput {
  readonly m: number;
  readonly t: number;
  readonly p: number;
  readonly alg: typeof KDF_ALG;
}

/** Decoded bytes + originally-supplied base64 string (re-emitted as-is for storage). */
export interface DecodedBytes {
  readonly bytes: Uint8Array;
  readonly base64: string;
}

export interface CreateKeyInput {
  readonly publicKey: DecodedBytes;
  readonly fingerprint: string;
  readonly wrappedPrivateKey: DecodedBytes;
  readonly kdfSalt: DecodedBytes;
  readonly kdfParams: KdfParamsInput;
}

export interface RotatePasswordInput {
  readonly kind: 'rotate-password';
  readonly wrappedPrivateKey: DecodedBytes;
  readonly kdfSalt: DecodedBytes;
  readonly kdfParams: KdfParamsInput;
}

export interface ReplaceIdentityInput {
  readonly kind: 'replace-identity';
  readonly publicKey: DecodedBytes;
  readonly fingerprint: string;
  readonly wrappedPrivateKey: DecodedBytes;
  readonly kdfSalt: DecodedBytes;
  readonly kdfParams: KdfParamsInput;
}

export type PatchInput = RotatePasswordInput | ReplaceIdentityInput;

export type ValidationError =
  | { code: 'invalid_json'; message: string }
  | { code: 'invalid_field'; field: string; message: string }
  | { code: 'kdf_params_too_weak'; message: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ValidationError };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function decodeBase64(input: unknown, field: string): ParseResult<DecodedBytes> {
  if (typeof input !== 'string' || input.length === 0) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field,
        message: `${field} must be a non-empty base64 string`,
      },
    };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    return {
      ok: false,
      error: { code: 'invalid_field', field, message: `${field} must be base64` },
    };
  }
  try {
    const bytes = new Uint8Array(Buffer.from(input, 'base64'));
    return { ok: true, value: { bytes, base64: input } };
  } catch {
    return {
      ok: false,
      error: { code: 'invalid_field', field, message: `${field} must be base64` },
    };
  }
}

function parsePublicKey(input: unknown): ParseResult<DecodedBytes> {
  const decoded = decodeBase64(input, 'public_key');
  if (!decoded.ok) return decoded;
  if (decoded.value.bytes.length !== PUBLIC_KEY_BYTES) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'public_key',
        message: `public_key must decode to ${String(PUBLIC_KEY_BYTES)} bytes`,
      },
    };
  }
  return decoded;
}

function parseFingerprint(input: unknown): ParseResult<string> {
  if (typeof input !== 'string' || !FINGERPRINT_REGEX.test(input)) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'fingerprint',
        message: 'fingerprint must be 32 lowercase hex chars',
      },
    };
  }
  return { ok: true, value: input };
}

function parseWrappedPrivateKey(input: unknown): ParseResult<DecodedBytes> {
  const decoded = decodeBase64(input, 'wrapped_private_key');
  if (!decoded.ok) return decoded;
  const len = decoded.value.bytes.length;
  if (len < WRAPPED_SK_MIN_BYTES || len > WRAPPED_SK_MAX_BYTES) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'wrapped_private_key',
        message: `wrapped_private_key length out of range [${String(WRAPPED_SK_MIN_BYTES)}, ${String(WRAPPED_SK_MAX_BYTES)}]`,
      },
    };
  }
  return decoded;
}

function parseKdfSalt(input: unknown): ParseResult<DecodedBytes> {
  const decoded = decodeBase64(input, 'kdf_salt');
  if (!decoded.ok) return decoded;
  if (decoded.value.bytes.length !== KDF_SALT_BYTES) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'kdf_salt',
        message: `kdf_salt must decode to ${String(KDF_SALT_BYTES)} bytes`,
      },
    };
  }
  return decoded;
}

export function parseKdfParams(input: unknown): ParseResult<KdfParamsInput> {
  if (input === undefined || input === null) {
    return { ok: true, value: KDF_DEFAULT };
  }
  if (!isPlainObject(input)) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'kdf_params',
        message: 'kdf_params must be an object',
      },
    };
  }
  const { m, t, p, alg } = input;
  if (
    typeof m !== 'number' ||
    !Number.isInteger(m) ||
    typeof t !== 'number' ||
    !Number.isInteger(t) ||
    typeof p !== 'number' ||
    !Number.isInteger(p)
  ) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'kdf_params',
        message: 'kdf_params {m,t,p} must be integers',
      },
    };
  }
  if (alg !== KDF_ALG) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'kdf_params',
        message: `kdf_params.alg must be "${KDF_ALG}"`,
      },
    };
  }
  if (m < KDF_MIN_M || t < KDF_MIN_T || p < KDF_MIN_P) {
    return { ok: false, error: { code: 'kdf_params_too_weak', message: 'kdf_params too weak' } };
  }
  return { ok: true, value: { m, t, p, alg: KDF_ALG } };
}

function parseJsonBody(raw: string): ParseResult<unknown> {
  if (raw.length === 0) {
    return { ok: false, error: { code: 'invalid_json', message: 'request body is empty' } };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body is not valid JSON' },
    };
  }
}

export function parseCreateKey(raw: string): ParseResult<CreateKeyInput> {
  const json = parseJsonBody(raw);
  if (!json.ok) return json;
  if (!isPlainObject(json.value)) {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body must be a JSON object' },
    };
  }
  const body = json.value;
  const pk = parsePublicKey(body.public_key);
  if (!pk.ok) return pk;
  const fp = parseFingerprint(body.fingerprint);
  if (!fp.ok) return fp;
  const wsk = parseWrappedPrivateKey(body.wrapped_private_key);
  if (!wsk.ok) return wsk;
  const salt = parseKdfSalt(body.kdf_salt);
  if (!salt.ok) return salt;
  const params = parseKdfParams(body.kdf_params);
  if (!params.ok) return params;
  return {
    ok: true,
    value: {
      publicKey: pk.value,
      fingerprint: fp.value,
      wrappedPrivateKey: wsk.value,
      kdfSalt: salt.value,
      kdfParams: params.value,
    },
  };
}

export function parsePatch(raw: string): ParseResult<PatchInput> {
  const json = parseJsonBody(raw);
  if (!json.ok) return json;
  if (!isPlainObject(json.value)) {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body must be a JSON object' },
    };
  }
  const body = json.value;
  const wsk = parseWrappedPrivateKey(body.wrapped_private_key);
  if (!wsk.ok) return wsk;
  const salt = parseKdfSalt(body.kdf_salt);
  if (!salt.ok) return salt;
  const params = parseKdfParams(body.kdf_params);
  if (!params.ok) return params;

  if (body.replace === true) {
    const pk = parsePublicKey(body.public_key);
    if (!pk.ok) return pk;
    const fp = parseFingerprint(body.fingerprint);
    if (!fp.ok) return fp;
    return {
      ok: true,
      value: {
        kind: 'replace-identity',
        publicKey: pk.value,
        fingerprint: fp.value,
        wrappedPrivateKey: wsk.value,
        kdfSalt: salt.value,
        kdfParams: params.value,
      },
    };
  }

  if (body.public_key !== undefined || body.fingerprint !== undefined) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'replace',
        message: 'public_key/fingerprint can only be sent with replace=true (spec §4.6 vs §4.7)',
      },
    };
  }

  return {
    ok: true,
    value: {
      kind: 'rotate-password',
      wrappedPrivateKey: wsk.value,
      kdfSalt: salt.value,
      kdfParams: params.value,
    },
  };
}
