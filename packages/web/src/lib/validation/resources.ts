/**
 * Validation helpers for `/api/crm/v1/orgs/:orgId/resources` requests.
 *
 * Spec docs/spec/cloud-resource-manager.md §3.1 (DB check constraints),
 * §6.3 (REST contract), §7.1 (register OrgResource flow).
 *
 * The validator mirrors the DB-level CHECK constraints so we surface a
 * clean 400 with a stable `code` instead of relying on a Postgres
 * error round-trip. Manual schema parsing (no zod dep) keeps the bundle
 * lean and lets us encode every regex/range in one place.
 */

import { findKind } from '@crm/catalog';

export const SLUG_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;

export type Scope = 'org' | 'project';

export interface RegisterResourceInput {
  readonly kind: string;
  readonly name: string;
  readonly scope: Scope;
  readonly projectId: string | null;
  readonly variant: string | null;
  readonly providerRef: string | null;
  readonly consoleUrl: string | null;
  readonly setupDocsUrl: string | null;
  readonly metadata: Record<string, unknown>;
  readonly adminResourceId: string | null;
  readonly secretManagerId: string | null;
}

export interface UpdateResourceInput {
  readonly name?: string;
  readonly variant?: string | null;
  readonly providerRef?: string | null;
  readonly consoleUrl?: string | null;
  readonly setupDocsUrl?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly status?: 'pending' | 'active' | 'failed' | 'detached';
}

export type ValidationError =
  | { code: 'invalid_json'; message: string }
  | { code: 'invalid_field'; field: string; message: string }
  | { code: 'unknown_kind'; message: string };

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

function parseSlug(input: unknown, field: string): ParseResult<string> {
  if (typeof input !== 'string' || !SLUG_REGEX.test(input)) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field,
        message: `${field} must match slug regex ${SLUG_REGEX.source}`,
      },
    };
  }
  return { ok: true, value: input };
}

function parseOptionalSlug(input: unknown, field: string): ParseResult<string | null> {
  if (input === undefined || input === null || input === '') {
    return { ok: true, value: null };
  }
  return parseSlug(input, field);
}

function parseOptionalString(input: unknown, field: string): ParseResult<string | null> {
  if (input === undefined || input === null || input === '') {
    return { ok: true, value: null };
  }
  if (typeof input !== 'string') {
    return {
      ok: false,
      error: { code: 'invalid_field', field, message: `${field} must be a string` },
    };
  }
  return { ok: true, value: input };
}

function parseOptionalUuid(input: unknown, field: string): ParseResult<string | null> {
  if (input === undefined || input === null || input === '') {
    return { ok: true, value: null };
  }
  if (
    typeof input !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)
  ) {
    return {
      ok: false,
      error: { code: 'invalid_field', field, message: `${field} must be a UUID` },
    };
  }
  return { ok: true, value: input };
}

function parseMetadata(input: unknown): ParseResult<Record<string, unknown>> {
  if (input === undefined || input === null) {
    return { ok: true, value: {} };
  }
  if (!isPlainObject(input)) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'metadata',
        message: 'metadata must be a JSON object',
      },
    };
  }
  return { ok: true, value: input };
}

export function parseRegisterResource(raw: string): ParseResult<RegisterResourceInput> {
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
  const kind = findKind(body.kind);
  if (!kind) {
    return { ok: false, error: { code: 'unknown_kind', message: `unknown kind: ${body.kind}` } };
  }

  const name = parseSlug(body.name, 'name');
  if (!name.ok) return name;

  // Derive scope from kindClass (spec §5.1): kindClass='project' -> scope='project',
  // kindClass='org' | 'org-admin' -> scope='org'. The client may pass `project_id`
  // for project-scoped kinds; we enforce the consistency check from §3.1.
  const scope: Scope = kind.kindClass === 'project' ? 'project' : 'org';

  const projectId = parseOptionalUuid(body.project_id, 'project_id');
  if (!projectId.ok) return projectId;
  if (scope === 'project' && projectId.value === null) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'project_id',
        message: 'project_id is required when scope=project',
      },
    };
  }
  if (scope === 'org' && projectId.value !== null) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'project_id',
        message: 'project_id must be null when scope=org',
      },
    };
  }

  const variant = parseOptionalSlug(body.variant, 'variant');
  if (!variant.ok) return variant;

  const providerRef = parseOptionalString(body.provider_ref, 'provider_ref');
  if (!providerRef.ok) return providerRef;

  const consoleUrl = parseOptionalString(body.console_url, 'console_url');
  if (!consoleUrl.ok) return consoleUrl;

  const setupDocsUrl = parseOptionalString(body.setup_docs_url, 'setup_docs_url');
  if (!setupDocsUrl.ok) return setupDocsUrl;

  const metadata = parseMetadata(body.metadata);
  if (!metadata.ok) return metadata;

  const adminResourceId = parseOptionalUuid(body.admin_resource_id, 'admin_resource_id');
  if (!adminResourceId.ok) return adminResourceId;
  if (adminResourceId.value !== null && scope !== 'project') {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'admin_resource_id',
        message: 'admin_resource_id is only allowed when scope=project (spec §3.1)',
      },
    };
  }

  const secretManagerId = parseOptionalUuid(body.secret_manager_id, 'secret_manager_id');
  if (!secretManagerId.ok) return secretManagerId;

  return {
    ok: true,
    value: {
      kind: kind.id,
      name: name.value,
      scope,
      projectId: projectId.value,
      variant: variant.value,
      providerRef: providerRef.value,
      consoleUrl: consoleUrl.value,
      setupDocsUrl: setupDocsUrl.value,
      metadata: metadata.value,
      adminResourceId: adminResourceId.value,
      secretManagerId: secretManagerId.value,
    },
  };
}

const ALLOWED_UPDATE_STATUSES = ['pending', 'active', 'failed', 'detached'] as const;

export function parseUpdateResource(raw: string): ParseResult<UpdateResourceInput> {
  const json = parseJsonBody(raw);
  if (!json.ok) return json;
  if (!isPlainObject(json.value)) {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body must be a JSON object' },
    };
  }
  const body = json.value;

  // Disallow changing kind / scope / project_id / admin_resource_id / is_admin via PATCH.
  for (const forbidden of [
    'kind',
    'scope',
    'project_id',
    'admin_resource_id',
    'is_admin',
    'provider_name',
    'organization_id',
    'secret_manager_id',
  ]) {
    if (body[forbidden] !== undefined) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: forbidden,
          message: `${forbidden} cannot be changed via PATCH (re-register required)`,
        },
      };
    }
  }

  const out: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = parseSlug(body.name, 'name');
    if (!name.ok) return name;
    out.name = name.value;
  }
  if (body.variant !== undefined) {
    const variant = parseOptionalSlug(body.variant, 'variant');
    if (!variant.ok) return variant;
    out.variant = variant.value;
  }
  if (body.provider_ref !== undefined) {
    const ref = parseOptionalString(body.provider_ref, 'provider_ref');
    if (!ref.ok) return ref;
    out.providerRef = ref.value;
  }
  if (body.console_url !== undefined) {
    const url = parseOptionalString(body.console_url, 'console_url');
    if (!url.ok) return url;
    out.consoleUrl = url.value;
  }
  if (body.setup_docs_url !== undefined) {
    const url = parseOptionalString(body.setup_docs_url, 'setup_docs_url');
    if (!url.ok) return url;
    out.setupDocsUrl = url.value;
  }
  if (body.metadata !== undefined) {
    const md = parseMetadata(body.metadata);
    if (!md.ok) return md;
    out.metadata = md.value;
  }
  if (body.status !== undefined) {
    if (
      typeof body.status !== 'string' ||
      !ALLOWED_UPDATE_STATUSES.includes(body.status as (typeof ALLOWED_UPDATE_STATUSES)[number])
    ) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'status',
          message: `status must be one of ${ALLOWED_UPDATE_STATUSES.join('|')}`,
        },
      };
    }
    out.status = body.status;
  }

  return { ok: true, value: out as unknown as UpdateResourceInput };
}

export interface ListResourceFilters {
  readonly scope?: Scope;
  readonly projectId?: string;
  readonly variant?: string;
  readonly kind?: string;
  readonly isAdmin?: boolean;
}

export function parseListFilters(searchParams: URLSearchParams): ParseResult<ListResourceFilters> {
  const out: { -readonly [K in keyof ListResourceFilters]: ListResourceFilters[K] } = {};

  const scope = searchParams.get('scope');
  if (scope !== null) {
    if (scope !== 'org' && scope !== 'project') {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'scope',
          message: 'scope must be org|project',
        },
      };
    }
    out.scope = scope;
  }

  const projectId = searchParams.get('project') ?? searchParams.get('project_id');
  if (projectId !== null && projectId !== '') {
    const v = parseOptionalUuid(projectId, 'project');
    if (!v.ok) return v;
    if (v.value !== null) out.projectId = v.value;
  }

  const variant = searchParams.get('variant');
  if (variant !== null && variant !== '') {
    const v = parseOptionalSlug(variant, 'variant');
    if (!v.ok) return v;
    if (v.value !== null) out.variant = v.value;
  }

  const kind = searchParams.get('kind');
  if (kind !== null && kind !== '') {
    out.kind = kind;
  }

  const isAdmin = searchParams.get('isAdmin');
  if (isAdmin !== null && isAdmin !== '') {
    if (isAdmin !== 'true' && isAdmin !== 'false') {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'isAdmin',
          message: 'isAdmin must be true|false',
        },
      };
    }
    out.isAdmin = isAdmin === 'true';
  }

  return { ok: true, value: out };
}
