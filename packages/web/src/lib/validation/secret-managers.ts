/**
 * Validation helpers for `/api/crm/v1/orgs/:orgId/secret-managers`.
 *
 * Spec docs/spec/cloud-resource-manager.md §6.2 (REST), §5.2 (contract).
 *
 * - `kind` is restricted to `'infisical'` in v1; `'vault'` and
 *   `'1password'` come back as a stable 400 `not_implemented`. Other
 *   strings get `invalid_field`.
 * - `config` must be a JSON object. For `kind='infisical'` we mandate
 *   `workspace_id` (UUID string) and `endpoint` (https URL); other
 *   keys are accepted as-is (the future Vault SM will use a different
 *   schema).
 * - `auth_sealed_blob` is the canonical sealed bundle (spec §4.3, `v: 1`
 *   shape) carrying the machine-identity `(clientId, clientSecret)`
 *   JSON. We reuse the shape validation from
 *   `lib/validation/sealed-blob.ts` to stay in lock-step with the
 *   `/access/:key` PUT validator.
 * - `is_default` is an optional boolean (defaults to false). Exactly
 *   one row per org may carry it (DB unique partial index); the route
 *   handler maintains the invariant in a transaction-style swap.
 *
 * Mirrors the style of `lib/validation/resources.ts` (manual schema
 * parse, no zod dep).
 */

import { parseSealedBlob, type SealedBlobV1Wire } from './sealed-blob';

export const SLUG_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;

export type SecretManagerKind = 'infisical';

export const SUPPORTED_KINDS: ReadonlyArray<SecretManagerKind> = ['infisical'];

export const NOT_IMPLEMENTED_KINDS: ReadonlyArray<string> = ['vault', '1password'];

export interface InfisicalConfig {
  readonly workspace_id: string;
  readonly endpoint: string;
  readonly environment?: string;
}

export interface CreateSecretManagerInput {
  readonly kind: SecretManagerKind;
  readonly name: string;
  readonly config: InfisicalConfig;
  readonly auth_sealed_blob: SealedBlobV1Wire;
  readonly is_default: boolean;
}

export interface UpdateSecretManagerInput {
  readonly name?: string;
  readonly is_default?: boolean;
  readonly config?: InfisicalConfig;
  readonly auth_sealed_blob?: SealedBlobV1Wire;
}

export type ValidationError =
  | { code: 'invalid_json'; message: string }
  | { code: 'invalid_field'; field: string; message: string }
  | { code: 'not_implemented'; message: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ValidationError };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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

function parseInfisicalConfig(input: unknown): ParseResult<InfisicalConfig> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      error: { code: 'invalid_field', field: 'config', message: 'config must be a JSON object' },
    };
  }
  const workspaceId = input.workspace_id;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'config.workspace_id',
        message: 'config.workspace_id must be a non-empty string',
      },
    };
  }
  const endpoint = input.endpoint;
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'config.endpoint',
        message: 'config.endpoint must be an http(s) URL',
      },
    };
  }
  const environment = input.environment;
  if (environment !== undefined && environment !== null && typeof environment !== 'string') {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'config.environment',
        message: 'config.environment must be a string when present',
      },
    };
  }
  const out: InfisicalConfig =
    typeof environment === 'string'
      ? { workspace_id: workspaceId, endpoint, environment }
      : { workspace_id: workspaceId, endpoint };
  return { ok: true, value: out };
}

export function parseCreateSecretManager(raw: string): ParseResult<CreateSecretManagerInput> {
  const json = parseJsonBody(raw);
  if (!json.ok) return json;
  if (!isPlainObject(json.value)) {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body must be a JSON object' },
    };
  }
  const body = json.value;

  if (typeof body.kind !== 'string') {
    return {
      ok: false,
      error: { code: 'invalid_field', field: 'kind', message: 'kind must be a string' },
    };
  }
  if (NOT_IMPLEMENTED_KINDS.includes(body.kind)) {
    return {
      ok: false,
      error: {
        code: 'not_implemented',
        message: `kind '${body.kind}' is not implemented in v1 (spec §5.2)`,
      },
    };
  }
  if (!SUPPORTED_KINDS.includes(body.kind as SecretManagerKind)) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'kind',
        message: `kind must be one of ${SUPPORTED_KINDS.join('|')}`,
      },
    };
  }
  const kind = body.kind as SecretManagerKind;

  if (typeof body.name !== 'string' || !SLUG_REGEX.test(body.name)) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'name',
        message: `name must match slug regex ${SLUG_REGEX.source}`,
      },
    };
  }

  const cfg = parseInfisicalConfig(body.config);
  if (!cfg.ok) return cfg;

  if (body.auth_sealed_blob === undefined || body.auth_sealed_blob === null) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'auth_sealed_blob',
        message: 'auth_sealed_blob is required',
      },
    };
  }
  const blob = parseSealedBlob(JSON.stringify({ sealed_blob: body.auth_sealed_blob }));
  if (!blob.ok) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'auth_sealed_blob',
        message: blob.error.message,
      },
    };
  }

  const isDefault =
    body.is_default === undefined || body.is_default === null ? false : body.is_default === true;
  if (body.is_default !== undefined && typeof body.is_default !== 'boolean') {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'is_default',
        message: 'is_default must be a boolean',
      },
    };
  }

  return {
    ok: true,
    value: {
      kind,
      name: body.name,
      config: cfg.value,
      auth_sealed_blob: blob.value,
      is_default: isDefault,
    },
  };
}

export function parseUpdateSecretManager(raw: string): ParseResult<UpdateSecretManagerInput> {
  const json = parseJsonBody(raw);
  if (!json.ok) return json;
  if (!isPlainObject(json.value)) {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body must be a JSON object' },
    };
  }
  const body = json.value;

  // Disallow changing kind / org / id via PATCH.
  for (const forbidden of ['kind', 'organization_id', 'id']) {
    if (body[forbidden] !== undefined) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: forbidden,
          message: `${forbidden} cannot be changed via PATCH`,
        },
      };
    }
  }

  const out: { -readonly [K in keyof UpdateSecretManagerInput]: UpdateSecretManagerInput[K] } = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !SLUG_REGEX.test(body.name)) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'name',
          message: `name must match slug regex ${SLUG_REGEX.source}`,
        },
      };
    }
    out.name = body.name;
  }
  if (body.is_default !== undefined) {
    if (typeof body.is_default !== 'boolean') {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'is_default',
          message: 'is_default must be a boolean',
        },
      };
    }
    out.is_default = body.is_default;
  }
  if (body.config !== undefined) {
    const cfg = parseInfisicalConfig(body.config);
    if (!cfg.ok) return cfg;
    out.config = cfg.value;
  }
  if (body.auth_sealed_blob !== undefined) {
    const blob = parseSealedBlob(JSON.stringify({ sealed_blob: body.auth_sealed_blob }));
    if (!blob.ok) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'auth_sealed_blob',
          message: blob.error.message,
        },
      };
    }
    out.auth_sealed_blob = blob.value;
  }

  if (Object.keys(out).length === 0) {
    return {
      ok: false,
      error: { code: 'invalid_field', field: 'body', message: 'PATCH body has no updatable field' },
    };
  }

  return { ok: true, value: out };
}
