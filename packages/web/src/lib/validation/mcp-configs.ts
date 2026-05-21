/**
 * Validation helpers for `/api/crm/v1/orgs/:orgId/mcp-configs/regenerate`
 * and the related GET list endpoint.
 *
 * Spec docs/spec/cloud-resource-manager.md §6.6.
 *
 * Manual schema parsing (no zod dep) — matches the style of the
 * neighbouring validators in `@/lib/validation/resources` etc.
 */

export const SLUG_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RegenerateMcpConfigInput {
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

export function parseRegenerateBody(raw: string): ParseResult<RegenerateMcpConfigInput> {
  const json = parseJsonBody(raw);
  if (!json.ok) return json;
  if (!isPlainObject(json.value)) {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body must be a JSON object' },
    };
  }
  const body = json.value;

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

export interface ListMcpConfigFilters {
  readonly projectId?: string;
  readonly variant?: string;
}

export function parseListMcpConfigFilters(
  searchParams: URLSearchParams,
): ParseResult<ListMcpConfigFilters> {
  const out: { -readonly [K in keyof ListMcpConfigFilters]: ListMcpConfigFilters[K] } = {};

  const projectId = searchParams.get('project') ?? searchParams.get('project_id');
  if (projectId !== null && projectId !== '') {
    if (!UUID_REGEX.test(projectId)) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'project',
          message: 'project must be a UUID',
        },
      };
    }
    out.projectId = projectId;
  }

  const variant = searchParams.get('variant');
  if (variant !== null && variant !== '') {
    if (!SLUG_REGEX.test(variant)) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'variant',
          message: `variant must match slug regex ${SLUG_REGEX.source}`,
        },
      };
    }
    out.variant = variant;
  }

  return { ok: true, value: out };
}
