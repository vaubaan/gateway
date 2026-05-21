/**
 * Validation helpers for `/api/crm/v1/orgs/:orgId/exports/*` route
 * handlers.
 *
 * Spec docs/spec/cloud-resource-manager.md §6.7, §7.5.
 *
 * Manual schema parsing (no zod dep). Mirrors the style of the
 * neighbouring validators (`@/lib/validation/resources.ts`).
 */

export const SLUG_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EnvFormat = 'dotenv' | 'json';

export interface ExportEnvInput {
  readonly scope: 'org' | 'project';
  readonly scopeId: string | null;
  readonly variant: string | null;
  readonly format: EnvFormat;
}

export interface ExportMcpInput {
  readonly scope: 'org' | 'project';
  readonly scopeId: string | null;
  readonly variant: string | null;
}

export type ValidationError =
  | { code: 'invalid_json'; message: string }
  | { code: 'invalid_field'; field: string; message: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ValidationError };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJsonBody(raw: string): ParseResult<unknown> {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body is not valid JSON' },
    };
  }
}

function parseScopeFields(
  body: Record<string, unknown>,
): ParseResult<{ scope: 'org' | 'project'; scopeId: string | null; variant: string | null }> {
  const rawScope = body.scope;
  if (rawScope !== 'org' && rawScope !== 'project') {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'scope',
        message: 'scope must be "org" or "project"',
      },
    };
  }

  let scopeId: string | null = null;
  const rawScopeId = body.scopeId ?? body.scope_id;
  if (rawScopeId !== undefined && rawScopeId !== null && rawScopeId !== '') {
    if (typeof rawScopeId !== 'string' || !UUID_REGEX.test(rawScopeId)) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'scopeId',
          message: 'scopeId must be a UUID (the project_id when scope=project)',
        },
      };
    }
    scopeId = rawScopeId;
  }

  if (rawScope === 'project' && scopeId === null) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'scopeId',
        message: 'scopeId is required when scope=project',
      },
    };
  }
  if (rawScope === 'org' && scopeId !== null) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'scopeId',
        message: 'scopeId must be omitted when scope=org',
      },
    };
  }

  let variant: string | null = null;
  const rawVariant = body.variant;
  if (rawVariant !== undefined && rawVariant !== null && rawVariant !== '') {
    if (typeof rawVariant !== 'string' || !SLUG_REGEX.test(rawVariant)) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'variant',
          message: `variant must match slug regex ${SLUG_REGEX.source}`,
        },
      };
    }
    variant = rawVariant;
  }

  return { ok: true, value: { scope: rawScope, scopeId, variant } };
}

export function parseExportEnvBody(raw: string): ParseResult<ExportEnvInput> {
  const json = parseJsonBody(raw);
  if (!json.ok) return json;
  if (!isPlainObject(json.value)) {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body must be a JSON object' },
    };
  }
  const body = json.value;

  const scope = parseScopeFields(body);
  if (!scope.ok) return scope;

  let format: EnvFormat = 'dotenv';
  const rawFormat = body.format;
  if (rawFormat !== undefined && rawFormat !== null && rawFormat !== '') {
    if (rawFormat !== 'dotenv' && rawFormat !== 'json') {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'format',
          message: 'format must be "dotenv" or "json"',
        },
      };
    }
    format = rawFormat;
  }

  return {
    ok: true,
    value: { ...scope.value, format },
  };
}

export function parseExportMcpBody(raw: string): ParseResult<ExportMcpInput> {
  const json = parseJsonBody(raw);
  if (!json.ok) return json;
  if (!isPlainObject(json.value)) {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body must be a JSON object' },
    };
  }
  const body = json.value;
  const scope = parseScopeFields(body);
  if (!scope.ok) return scope;
  return { ok: true, value: scope.value };
}
