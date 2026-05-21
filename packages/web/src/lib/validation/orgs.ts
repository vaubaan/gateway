/**
 * Validation for `POST /api/crm/v1/orgs` (Phase 4 wave C — onboarding).
 * Spec §3.1: slug regex, name non-empty.
 */

export const SLUG_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;

export interface CreateOrgInput {
  readonly slug: string;
  readonly name: string;
}

export type ValidationError =
  | { code: 'invalid_json'; message: string }
  | { code: 'invalid_field'; field: string; message: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ValidationError };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseCreateOrg(raw: string): ParseResult<CreateOrgInput> {
  if (raw.length === 0) {
    return { ok: false, error: { code: 'invalid_json', message: 'empty body' } };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: 'invalid_json', message: 'invalid JSON' } };
  }
  if (!isPlainObject(json)) {
    return { ok: false, error: { code: 'invalid_json', message: 'body must be an object' } };
  }
  const slug = json.slug;
  if (typeof slug !== 'string' || !SLUG_REGEX.test(slug)) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'slug',
        message: `slug must match ${SLUG_REGEX.source}`,
      },
    };
  }
  const name = json.name;
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
    return {
      ok: false,
      error: {
        code: 'invalid_field',
        field: 'name',
        message: 'name must be a non-empty string ≤ 200 chars',
      },
    };
  }
  return { ok: true, value: { slug, name: name.trim() } };
}
