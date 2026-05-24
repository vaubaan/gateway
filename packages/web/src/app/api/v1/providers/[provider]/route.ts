/**
 * DELETE /api/v1/providers/:provider?orgSlug=...
 *
 * Disconnects a ProviderAdmin: flips status to 'revoked' and wipes the
 * encrypted token. All subsequent /mcp calls targeting this provider for
 * this org will deny with "provider not connected".
 *
 * Spec : docs/spec/mcp-proxy.md §8.2, §9.6 ("Révoquer un ProviderAdmin").
 *
 * Cache invalidation : we drop every cached BotContext for this org (we
 * scan by org_id since context cache keys are api_key_prefix-based).
 * In practice this means a small set of DELs.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { buildCacheClient } from '@vauban/mcp-gateway';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgAdmin } from '@/lib/auth/require-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_PROVIDERS = new Set(['github', 'vercel', 'supabase']);

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  if (!VALID_PROVIDERS.has(provider)) {
    return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
  }
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug) {
    return NextResponse.json({ error: 'orgSlug query param required' }, { status: 400 });
  }

  const guard = await requireOrgAdmin(orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  // Wipe token + flip status so any in-flight cached call also gets denied
  // once the cache TTL expires (we proactively invalidate just below).
  const { error } = await svc
    .from('provider_admins')
    .update({
      status: 'revoked',
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      installation_id: null,
    })
    .eq('organization_id', guard.orgId)
    .eq('provider', provider);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Best-effort cache invalidation for the org's bots.
  const { data: bots } = await svc
    .from('bots')
    .select('api_key_prefix, projects!inner(organization_id)')
    .eq('projects.organization_id', guard.orgId);
  const cache = buildCacheClient();
  for (const b of (bots ?? []) as Array<{ api_key_prefix: string }>) {
    await cache.del(`vauban:ctx:${b.api_key_prefix}`);
  }

  return NextResponse.json({ ok: true });
}
