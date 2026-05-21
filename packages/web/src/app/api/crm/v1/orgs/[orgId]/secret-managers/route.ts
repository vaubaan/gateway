/**
 * `/api/crm/v1/orgs/:orgId/secret-managers` — collection endpoints (spec §6.2).
 *
 * - `GET`  : list SMs visible to the user (RLS `secret_managers_select_member`).
 * - `POST` : register a new SM. v1 accepts `kind='infisical'` only.
 *            `vault` / `1password` return 400 `not_implemented`.
 *
 * `is_default=true` is mutually exclusive within an org (DB partial
 * unique index `secret_managers_one_default_per_org`). When the
 * request sets the flag, we first unset the existing default in the
 * same logical operation (best-effort: not a single SQL transaction
 * because supabase-js doesn't expose `BEGIN…COMMIT`, but the unset is
 * RLS-gated to the same admin so the failure modes are safe).
 *
 * ZK invariant: `auth_sealed_blob` is opaque ciphertext. We NEVER log
 * its bytes nor any portion of the recipient list — the audit `subject`
 * only carries `{ kind, name, is_default, recipient_count }`.
 */

import { type NextRequest, NextResponse } from 'next/server';

import {
  findOrgIdBySlugOrId,
  getDb,
  sealedAuthToBytea,
  type SecretManagerRow,
} from '@/lib/secret-managers/db';
import { parseCreateSecretManager, type ValidationError } from '@/lib/validation/secret-managers';

export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{ readonly orgId: string }>;
}

const SM_COLS = 'id, organization_id, kind, name, is_default, config, created_at';

function noStore(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

function jsonResponse(body: unknown, status: number): NextResponse {
  return noStore(NextResponse.json(body, { status }));
}

function errorResponse(code: string, status: number, message?: string): NextResponse {
  return jsonResponse({ error: code, ...(message !== undefined ? { message } : {}) }, status);
}

function validationErrorResponse(err: ValidationError): NextResponse {
  if (err.code === 'not_implemented') return errorResponse(err.code, 400, err.message);
  if (err.code === 'invalid_field') return errorResponse(err.code, 400, err.message);
  return errorResponse(err.code, 400, err.message);
}

interface SmListRow {
  readonly id: string;
  readonly organization_id: string;
  readonly kind: string;
  readonly name: string;
  readonly is_default: boolean;
  readonly config: Record<string, unknown>;
  readonly created_at: string;
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const { data, error } = (await db
    .from('secret_managers')
    .select(SM_COLS)
    .eq('organization_id', org.id)
    .order('created_at', { ascending: false })) as {
    data: ReadonlyArray<SmListRow> | null;
    error: { code?: string; message: string } | null;
  };
  if (error) return errorResponse('database_error', 500);
  return jsonResponse({ secret_managers: data ?? [] }, 200);
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const raw = await req.text();
  const parsed = parseCreateSecretManager(raw);
  if (!parsed.ok) return validationErrorResponse(parsed.error);
  const input = parsed.value;

  // If is_default=true: unset any current default first. RLS-gated on
  // the same admin; the partial unique index prevents the row insert
  // from racing into a "two defaults" state — the worst case is a
  // failed insert that the caller retries.
  if (input.is_default) {
    const unsetResult = await db
      .from('secret_managers')
      .update({ is_default: false })
      .eq('organization_id', org.id)
      .eq('is_default', true)
      .select('id');
    const unsetErr = unsetResult.error;
    if (unsetErr) {
      if (unsetErr.code === '42501') return errorResponse('forbidden', 403);
      return errorResponse('database_error', 500, unsetErr.message);
    }
  }

  const insertRow = {
    organization_id: org.id,
    kind: input.kind,
    name: input.name,
    is_default: input.is_default,
    config: input.config,
    auth_sealed_blob: sealedAuthToBytea(input.auth_sealed_blob),
  };

  const { data: insertedRaw, error } = (await db
    .from('secret_managers')
    .insert(insertRow)
    .select(SM_COLS)
    .single()) as {
    data: SecretManagerRow | null;
    error: { code?: string; message: string } | null;
  };

  if (error) {
    if (error.code === '23505') return errorResponse('conflict', 409, 'name already used in org');
    if (error.code === '42501') return errorResponse('forbidden', 403);
    return errorResponse('database_error', 500, error.message);
  }
  if (!insertedRaw) return errorResponse('forbidden', 403);
  const inserted = insertedRaw;

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'secret_manager.created',
    scope: { secret_manager_id: inserted.id, kind: inserted.kind, name: inserted.name },
    subject: {
      kind: inserted.kind,
      name: inserted.name,
      is_default: inserted.is_default,
      recipient_count: input.auth_sealed_blob.recipients.length,
    },
  });

  return jsonResponse({ secret_manager: inserted }, 201);
}
