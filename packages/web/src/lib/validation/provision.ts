/**
 * Validation helpers for `POST /api/crm/v1/orgs/:orgId/resources/:rId/provision`.
 *
 * Spec docs/spec/cloud-resource-manager.md §6.5, §7.3.
 *
 * The validator is strict on shape but does NOT touch any cleartext
 * credential. The body carries:
 *
 *   - childKind   : the ProjectResourceKind id (e.g. github-repo).
 *   - name        : slug for the new Resource.
 *   - project_id  : UUID of the target Project.
 *   - variant     : optional slug (a la prod/staging).
 *   - provider_ref: the providerRef returned by admin.createChild(...).
 *                   This is NOT a secret (e.g. 'vauban/repo1' for GitHub,
 *                   'prj_xxx' for Vercel, 'abcdefghij' for Supabase).
 *   - metadata    : provider_metadata for the new row (org/repo/ref…).
 *
 * The CRM never receives the child Access blob through /provision.
 * That happens later via PUT /access/:key with a sealed blob.
 */

const SLUG_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProvisionRequest {
  readonly childKind: string;
  readonly name: string;
  readonly projectId: string;
  readonly variant: string | null;
  readonly providerRef: string;
  readonly metadata: Record<string, unknown>;
}

export type ValidationError =
  | { code: 'invalid_json'; message: string }
  | { code: 'invalid_field'; field: string; message: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ValidationError };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseProvisionRequest(raw: string): ParseResult<ProvisionRequest> {
  if (raw.length === 0) {
    return { ok: false, error: { code: 'invalid_json', message: 'request body is empty' } };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body is not valid JSON' },
    };
  }
  if (!isPlainObject(json)) {
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'request body must be a JSON object' },
    };
  }
  const body = json;

  if (typeof body.childKind !== 'string' || body.childKind.length === 0) {
    return {
      ok: false,
      error: { code: 'invalid_field', field: 'childKind', message: 'childKind must be a string' },
    };
  }
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
  if (typeof body.project_id !== 'string' || !UUID_REGEX.test(body.project_id)) {
    return {
      ok: false,
      error: { code: 'invalid_field', field: 'project_id', message: 'project_id must be a UUID' },
    };
  }
  let variant: string | null = null;
  if (body.variant !== undefined && body.variant !== null && body.variant !== '') {
    if (typeof body.variant !== 'string' || !SLUG_REGEX.test(body.variant)) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'variant',
          message: `variant must match slug regex ${SLUG_REGEX.source}`,
        },
      };
    }
    variant = body.variant;
  }
  if (typeof body.provider_ref !== 'string' || body.provider_ref.length === 0) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'provider_ref',
        message: 'provider_ref must be a non-empty string returned by admin.createChild()',
      },
    };
  }
  let metadata: Record<string, unknown> = {};
  if (body.metadata !== undefined && body.metadata !== null) {
    if (!isPlainObject(body.metadata)) {
      return {
        ok: false,
        error: {
          code: 'invalid_field',
          field: 'metadata',
          message: 'metadata must be a JSON object',
        },
      };
    }
    metadata = body.metadata;
  }

  return {
    ok: true,
    value: {
      childKind: body.childKind,
      name: body.name,
      projectId: body.project_id,
      variant,
      providerRef: body.provider_ref,
      metadata,
    },
  };
}
