/**
 * Validation helpers for sealed_blob payloads on PUT
 * `/api/crm/v1/orgs/:orgId/resources/:rId/access/:key`.
 *
 * Spec docs/spec/cloud-resource-manager.md §4.3 (`SealedBlobV1` shape)
 * and §6.4 (REST contract). The on-disk format is canonical:
 *
 *     { v: 1, recipients: [{ fp, ct }] }
 *
 * - `v` is exactly `1` (literal).
 * - `recipients` is a non-empty array (a blob with 0 recipients would
 *   be unrecoverable for everyone — refused).
 * - Each entry has `fp` (32 lowercase hex chars — the canonical
 *   fingerprint format) and `ct` (base64 of `crypto_box_seal` output
 *   wrapping the cleartext, ≥ 48 bytes after decode: 32-byte ephemeral
 *   pubkey + 16-byte MAC). No padding is allowed inside the base64
 *   string beyond the standard `=` tail.
 * - The validator never logs `ct` or any portion of it (ZK invariant).
 */

export const FINGERPRINT_REGEX = /^[0-9a-f]{32}$/;
/** crypto_box_seal output = ephemeral_pubkey(32) + ciphertext + mac(16) ≥ 48. */
export const SEALED_BOX_MIN_BYTES = 48;
/** Hard upper bound to refuse pathological payloads up-front (1 MiB). */
export const SEALED_BLOB_MAX_BYTES = 1_048_576;

export interface SealedRecipientWire {
  readonly fp: string;
  readonly ct: string;
}

export interface SealedBlobV1Wire {
  readonly v: 1;
  readonly recipients: ReadonlyArray<SealedRecipientWire>;
}

export type ValidationError =
  | { code: 'invalid_json'; message: string }
  | { code: 'invalid_field'; field: string; message: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ValidationError };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJsonBody(raw: string): ParseResult<unknown> {
  if (raw.length === 0) {
    return { ok: false, error: { code: 'invalid_json', message: 'request body is empty' } };
  }
  if (raw.length > SEALED_BLOB_MAX_BYTES * 2) {
    return { ok: false, error: { code: 'invalid_json', message: 'request body too large' } };
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

function decodeAndCheckBase64(input: string, field: string, minBytes: number): ParseResult<string> {
  // Standard base64 charset, optional `=` padding tail.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    return {
      ok: false,
      error: { code: 'invalid_field', field, message: `${field} must be base64` },
    };
  }
  let len = 0;
  try {
    len = Buffer.from(input, 'base64').length;
  } catch {
    return {
      ok: false,
      error: { code: 'invalid_field', field, message: `${field} must be base64` },
    };
  }
  if (len < minBytes) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field,
        message: `${field} decodes to ${String(len)} bytes; minimum ${String(minBytes)} (sealed-box envelope)`,
      },
    };
  }
  return { ok: true, value: input };
}

export function parseSealedBlob(raw: string): ParseResult<SealedBlobV1Wire> {
  const json = parseJsonBody(raw);
  if (!json.ok) return json;
  if (!isPlainObject(json.value)) {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body must be a JSON object' },
    };
  }
  const body = json.value;
  // Accept either { sealed_blob: {...} } envelope or the blob directly
  // (some early callers may post the blob at the root). The wizard
  // (Phase 4 wave C) posts `{ sealed_blob }`.
  const blob = isPlainObject(body.sealed_blob) ? body.sealed_blob : body;

  if (blob.v !== 1) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'sealed_blob.v',
        message: 'sealed_blob.v must be 1 (only SealedBlobV1 supported)',
      },
    };
  }
  if (!Array.isArray(blob.recipients) || blob.recipients.length === 0) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'sealed_blob.recipients',
        message: 'sealed_blob.recipients must be a non-empty array (≥ 1 recipient)',
      },
    };
  }
  const seenFp = new Set<string>();
  const recipients: SealedRecipientWire[] = [];
  for (let i = 0; i < blob.recipients.length; i++) {
    const r: unknown = blob.recipients[i];
    if (!isPlainObject(r)) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: `sealed_blob.recipients[${String(i)}]`,
          message: 'recipient must be an object { fp, ct }',
        },
      };
    }
    const fp = r.fp;
    if (typeof fp !== 'string' || !FINGERPRINT_REGEX.test(fp)) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: `sealed_blob.recipients[${String(i)}].fp`,
          message: 'fp must be 32 lowercase hex chars',
        },
      };
    }
    if (seenFp.has(fp)) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: `sealed_blob.recipients[${String(i)}].fp`,
          message: 'duplicate fingerprint in recipients list',
        },
      };
    }
    seenFp.add(fp);
    const ct = r.ct;
    if (typeof ct !== 'string' || ct.length === 0) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: `sealed_blob.recipients[${String(i)}].ct`,
          message: 'ct must be a non-empty string',
        },
      };
    }
    const ctCheck = decodeAndCheckBase64(
      ct,
      `sealed_blob.recipients[${String(i)}].ct`,
      SEALED_BOX_MIN_BYTES,
    );
    if (!ctCheck.ok) return ctCheck;
    recipients.push({ fp, ct });
  }
  return { ok: true, value: { v: 1, recipients } };
}

/** Validation of an access key segment — must match the regex of the catalog's accessSchema keys. */
const ACCESS_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/;

export function isValidAccessKey(key: string): boolean {
  // Catalog uses uppercase env-var style keys (GITHUB_TOKEN, SUPABASE_URL …).
  return ACCESS_KEY_REGEX.test(key) && key.length <= 128;
}
