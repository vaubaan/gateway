/**
 * Programmatic AccessToken revoke — let a ManagementKey-authenticated caller
 * delete an AccessToken once a session is done. Avoids accumulating ephemeral
 * tokens in DB between the moment they're minted and the moment they expire.
 *
 *   DELETE /api/v1/mgmt/tokens/:tokenId
 *     Authorization: Bearer vbn_mgmt_…
 *
 *   returns 200 { ok: true } on success, 404 if the token doesn't belong to
 *   any project of the bound org.
 *
 * Cache invalidation : drops the cached AccessTokenContext for the token's
 * `api_key_prefix` so the next /mcp call rejects within ≤1 round-trip.
 *
 * Spec : docs/spec/vaubaan-gateway.md §8.8.
 * ADR  : docs/decisions/programmatic-access-token-minting.md.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { buildCacheClient } from '@vaubaan/mcp-gateway';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireManagementKey } from '@/lib/auth/require-management-key';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function invalidateCache(prefix: string) {
  await buildCacheClient().del(`vaubaan:ctx:${prefix}`);
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ tokenId: string }> }) {
  const guard = await requireManagementKey(req.headers.get('authorization'));
  if (!guard.ok) return guard.response;

  const { tokenId } = await ctx.params;
  const svc = getSupabaseServiceClient();

  const { data: token } = await svc
    .from('access_tokens')
    .select('id, api_key_prefix, projects!inner(organization_id)')
    .eq('id', tokenId)
    .maybeSingle<{
      id: string;
      api_key_prefix: string;
      projects: { organization_id: string };
    }>();
  if (!token || token.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'access token not found in this org' }, { status: 404 });
  }

  const { error } = await svc.from('access_tokens').delete().eq('id', tokenId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await invalidateCache(token.api_key_prefix);
  return NextResponse.json({ ok: true });
}
