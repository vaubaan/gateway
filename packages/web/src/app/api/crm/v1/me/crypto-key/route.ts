/**
 * `/api/crm/v1/me/crypto-key` — user crypto identity bootstrap & rotation.
 *
 * Spec docs/spec/cloud-resource-manager.md §4.1 (first-login bootstrap),
 * §4.6 (password rotation — pubkey unchanged), §4.7 (lost-password =
 * identity replace).
 *
 * The endpoint operates exclusively on the row `user_crypto_keys`
 * belonging to the authenticated user. RLS does the gating
 * (`user_id = auth.uid()`); this handler never uses service-role.
 *
 * Wire format: every bytea column (`public_key`, `wrapped_private_key`,
 * `kdf_salt`) is transported as base64 in JSON and converted to/from
 * PostgreSQL's `\x` hex literal at the supabase-js boundary.
 *
 * Side effect on POST/PATCH: a row is inserted into `public.audit_log`
 * with `organization_id = NULL`, `actor_user_id = auth.uid()`,
 * subject = `{fingerprint, [old_fingerprint]}`. The migration
 * `1001_audit_log_org_nullable.sql` adds the policies required.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  type CreateKeyInput,
  type DecodedBytes,
  type KdfParamsInput,
  type PatchInput,
  type ValidationError,
  parseCreateKey,
  parsePatch,
} from '@/lib/validation/crypto-key';

export const dynamic = 'force-dynamic';

type AuditAction =
  | 'user.crypto-key.created'
  | 'user.crypto-key.rotated-password'
  | 'user.crypto-key.replaced-identity';

interface AuditSubject {
  readonly fingerprint: string;
  readonly old_fingerprint?: string;
  readonly swept_stale_count?: number;
}

interface CryptoKeyRowDb {
  readonly public_key: string;
  readonly fingerprint: string;
  readonly wrapped_private_key: string;
  readonly kdf_salt: string;
  readonly kdf_params: KdfParamsInput;
  readonly created_at: string;
  readonly rotated_at: string;
}

interface DbError {
  readonly code?: string;
  readonly message: string;
}

interface DbResult<T> {
  readonly data: T;
  readonly error: DbError | null;
}

interface SelectChain extends Promise<DbResult<unknown>> {
  eq(col: string, val: string): SelectChain;
  maybeSingle(): Promise<DbResult<unknown>>;
}

interface UpdateChain {
  eq(col: string, val: string): Promise<DbResult<unknown>>;
}

interface FromTable {
  select(cols: string): SelectChain;
  insert(row: Record<string, unknown>): Promise<DbResult<unknown>>;
  update(row: Record<string, unknown>): UpdateChain;
}

interface NarrowedDb {
  auth: {
    getUser(): Promise<{ data: { user: { id: string } | null } }>;
  };
  from(table: string): FromTable;
}

async function getDb(): Promise<NarrowedDb> {
  // The Database type is not generated yet (phase 4 will land it). Narrow
  // the client to the shape we actually use here so the rest of the file
  // is type-safe end to end.
  const client: unknown = await createSupabaseServerClient();
  return client as NarrowedDb;
}

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
  return errorResponse(err.code, 400, err.message);
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

function toPgBytea(input: DecodedBytes): string {
  return `\\x${bytesToHex(input.bytes)}`;
}

function pgByteaToBase64(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('expected bytea string from postgres');
  }
  if (raw.startsWith('\\x')) {
    return Buffer.from(raw.slice(2), 'hex').toString('base64');
  }
  // PostgREST configured for base64 output already.
  return raw;
}

function projectRow(row: CryptoKeyRowDb): Record<string, unknown> {
  return {
    public_key: pgByteaToBase64(row.public_key),
    fingerprint: row.fingerprint,
    wrapped_private_key: pgByteaToBase64(row.wrapped_private_key),
    kdf_salt: pgByteaToBase64(row.kdf_salt),
    kdf_params: row.kdf_params,
    created_at: row.created_at,
    rotated_at: row.rotated_at,
  };
}

/**
 * Spec §4.7 step 4 — re-seal sweep on identity replacement.
 *
 * Mark every `resource_access` row whose sealed_blob's recipient list
 * contained the old fingerprint with `recipients_stale=true`. The
 * column was added by migration 1002.
 *
 * The user's session enforces RLS — they only see (and only update)
 * the access rows of orgs they're a member of. A user replacing their
 * identity who is *not* a member of any org will simply touch 0 rows;
 * an Admin elsewhere who is a member of N orgs sweeps the blobs across
 * all of them, which is the desired behaviour (spec §4.7).
 *
 * Returns the number of rows flipped (0 when the user has no
 * sealed_blob recipient anywhere).
 */
async function markResourceAccessStale(
  supabase: NarrowedDb,
  oldFingerprint: string,
): Promise<number> {
  // List candidate rows first — we have to look inside the bytea JSON
  // to test the recipient fingerprint, which is opaque to PostgREST.
  // The session's RLS makes this naturally org-scoped.
  const { data, error } = (await supabase
    .from('resource_access')
    .select('id, sealed_blob, recipients_stale')) as unknown as DbResult<
    ReadonlyArray<{ id: string; sealed_blob: unknown; recipients_stale: boolean }>
  >;
  if (error || !data) return 0;

  let touched = 0;
  for (const row of data) {
    if (row.recipients_stale) continue;
    const blob = decodeSealedBlobBytea(row.sealed_blob);
    if (
      typeof blob !== 'object' ||
      blob === null ||
      !Array.isArray((blob as { recipients?: unknown }).recipients)
    ) {
      continue;
    }
    const recipients = (blob as { recipients: Array<{ fp?: unknown }> }).recipients;
    if (!recipients.some((r) => typeof r.fp === 'string' && r.fp === oldFingerprint)) {
      continue;
    }
    const { error: updErr } = await supabase
      .from('resource_access')
      .update({ recipients_stale: true })
      .eq('id', row.id);
    if (!updErr) touched += 1;
  }
  return touched;
}

function decodeSealedBlobBytea(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('\\x')) {
      try {
        const hex = value.slice(2);
        const bytes = Buffer.from(hex, 'hex');
        return JSON.parse(bytes.toString('utf8'));
      } catch {
        return null;
      }
    }
    try {
      return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
  if (value instanceof Uint8Array) {
    try {
      return JSON.parse(Buffer.from(value).toString('utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

async function writeAuditLog(
  supabase: NarrowedDb,
  userId: string,
  action: AuditAction,
  subject: AuditSubject,
): Promise<void> {
  const { error } = await supabase.from('audit_log').insert({
    organization_id: null,
    actor_user_id: userId,
    action,
    scope: {},
    subject,
  });
  if (error) {
    // Do not surface DB internals or any payload bytes; an audit-log
    // failure must not leak through the response. The row write itself
    // already succeeded, so we keep a server-side warning trail.
    console.warn('[me/crypto-key] audit_log insert failed:', error.code ?? error.message);
  }
}

export async function GET(): Promise<NextResponse> {
  const supabase = await getDb();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return errorResponse('unauthorized', 401);

  const { data, error } = await supabase
    .from('user_crypto_keys')
    .select(
      'public_key, fingerprint, wrapped_private_key, kdf_salt, kdf_params, created_at, rotated_at',
    )
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) return errorResponse('database_error', 500);
  if (!data) return errorResponse('not_found', 404);
  return jsonResponse(projectRow(data as unknown as CryptoKeyRowDb), 200);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await getDb();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return errorResponse('unauthorized', 401);

  const raw = await req.text();
  const parsed = parseCreateKey(raw);
  if (!parsed.ok) return validationErrorResponse(parsed.error);

  const input: CreateKeyInput = parsed.value;
  const { error } = await supabase.from('user_crypto_keys').insert({
    user_id: user.id,
    public_key: toPgBytea(input.publicKey),
    fingerprint: input.fingerprint,
    wrapped_private_key: toPgBytea(input.wrappedPrivateKey),
    kdf_salt: toPgBytea(input.kdfSalt),
    kdf_params: input.kdfParams,
  });

  if (error) {
    // 23505 = unique_violation (PK on user_id) — the row already exists.
    if (error.code === '23505') return errorResponse('conflict', 409);
    console.error(
      '[crypto-key POST] insert failed',
      JSON.stringify({ code: error.code, message: error.message, user_id: user.id }),
    );
    return errorResponse('database_error', 500);
  }

  await writeAuditLog(supabase, user.id, 'user.crypto-key.created', {
    fingerprint: input.fingerprint,
  });

  return jsonResponse({ ok: true, fingerprint: input.fingerprint }, 201);
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supabase = await getDb();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return errorResponse('unauthorized', 401);

  const raw = await req.text();
  const parsed = parsePatch(raw);
  if (!parsed.ok) return validationErrorResponse(parsed.error);
  const input: PatchInput = parsed.value;

  // Read the existing row to (a) yield 404 cleanly if absent, and (b) capture
  // the old fingerprint for the replace-identity audit subject.
  const { data: existingRaw, error: readError } = await supabase
    .from('user_crypto_keys')
    .select('fingerprint')
    .eq('user_id', user.id)
    .maybeSingle();
  if (readError) return errorResponse('database_error', 500);
  if (!existingRaw) return errorResponse('not_found', 404);
  const existing = existingRaw as unknown as { fingerprint: string };

  if (input.kind === 'rotate-password') {
    const { error: updateError } = await supabase
      .from('user_crypto_keys')
      .update({
        wrapped_private_key: toPgBytea(input.wrappedPrivateKey),
        kdf_salt: toPgBytea(input.kdfSalt),
        kdf_params: input.kdfParams,
        rotated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id);
    if (updateError) return errorResponse('database_error', 500);

    await writeAuditLog(supabase, user.id, 'user.crypto-key.rotated-password', {
      fingerprint: existing.fingerprint,
    });
    return jsonResponse({ ok: true, fingerprint: existing.fingerprint }, 200);
  }

  // input.kind === 'replace-identity' (spec §4.7).
  const { error: updateError } = await supabase
    .from('user_crypto_keys')
    .update({
      public_key: toPgBytea(input.publicKey),
      fingerprint: input.fingerprint,
      wrapped_private_key: toPgBytea(input.wrappedPrivateKey),
      kdf_salt: toPgBytea(input.kdfSalt),
      kdf_params: input.kdfParams,
      rotated_at: new Date().toISOString(),
    })
    .eq('user_id', user.id);
  if (updateError) return errorResponse('database_error', 500);

  // Spec §4.7 step 4: every blob whose recipient list contained the old
  // fingerprint must be marked recipients_stale=true so the next admin
  // session re-seals it. The column landed in migration 1002.
  const sweptCount = await markResourceAccessStale(supabase, existing.fingerprint);

  await writeAuditLog(supabase, user.id, 'user.crypto-key.replaced-identity', {
    fingerprint: input.fingerprint,
    old_fingerprint: existing.fingerprint,
    swept_stale_count: sweptCount,
  });
  return jsonResponse(
    { ok: true, fingerprint: input.fingerprint, old_fingerprint: existing.fingerprint },
    200,
  );
}
