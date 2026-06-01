/**
 * Bearer-auth guard for /api/v1/mgmt/* routes.
 *
 * Verifies an `Authorization: Bearer vbn_mgmt_…` header against the
 * `org_management_keys` table (argon2id), returns the bound organization,
 * and best-effort touches `last_used_at`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §3.1 (ManagementKey), §8.
 * ADR  : docs/decisions/programmatic-access-token-minting.md.
 */

import { NextResponse } from 'next/server';
import { parseApiKey, verifyApiKey } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';

export interface ManagementKeyGuardOk {
  ok: true;
  orgId: string;
  managementKeyId: string;
}

export interface ManagementKeyGuardErr {
  ok: false;
  response: NextResponse;
}

export type ManagementKeyGuard = ManagementKeyGuardOk | ManagementKeyGuardErr;

interface ManagementKeyAuthRow {
  id: string;
  organization_id: string;
  api_key_hash: string;
  status: 'active' | 'revoked';
}

function unauthorized(message: string): ManagementKeyGuardErr {
  return {
    ok: false,
    response: NextResponse.json({ error: message }, { status: 401 }),
  };
}

export async function requireManagementKey(authHeader: string | null): Promise<ManagementKeyGuard> {
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return unauthorized(
      'missing or malformed Authorization header (expected `Bearer vbn_mgmt_…`).',
    );
  }
  const raw = authHeader.slice('bearer '.length).trim();
  const parsed = parseApiKey(raw);
  if (!parsed) return unauthorized('api_key format invalid.');
  if (parsed.kind !== 'mgmt') {
    return unauthorized('this endpoint requires a management key (vbn_mgmt_…).');
  }

  const svc = getSupabaseServiceClient();
  const { data: row } = await svc
    .from('org_management_keys')
    .select('id, organization_id, api_key_hash, status')
    .eq('api_key_prefix', parsed.prefix)
    .maybeSingle<ManagementKeyAuthRow>();
  if (!row) return unauthorized('unknown api_key.');
  if (row.status !== 'active') return unauthorized('management key is revoked.');
  if (!(await verifyApiKey(row.api_key_hash, raw))) return unauthorized('api_key mismatch.');

  // Best-effort touch ; never blocks the request on a DB hiccup.
  Promise.resolve(
    svc
      .from('org_management_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', row.id),
  ).catch((e: unknown) => {
    console.error('[require-management-key] touch last_used_at failed', e);
  });

  return { ok: true, orgId: row.organization_id, managementKeyId: row.id };
}
