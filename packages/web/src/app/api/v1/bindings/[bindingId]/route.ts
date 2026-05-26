/**
 * PATCH  /api/v1/bindings/:bindingId  body: { orgSlug, resource_ref?, display_name? }
 * DELETE /api/v1/bindings/:bindingId?orgSlug=...
 *
 * Spec : docs/spec/mcp-proxy.md §8.3.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { buildCacheClient } from '@vaubaan/mcp-gateway';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  orgSlug: z.string().min(1),
  resource_ref: z.string().min(1).optional(),
  display_name: z.string().nullable().optional(),
});

async function invalidateOrg(orgId: string) {
  const svc = getSupabaseServiceClient();
  const { data: bots } = await svc
    .from('access_tokens')
    .select('api_key_prefix, projects!inner(organization_id)')
    .eq('projects.organization_id', orgId);
  const cache = buildCacheClient();
  for (const b of (bots ?? []) as Array<{ api_key_prefix: string }>) {
    await cache.del(`vaubaan:ctx:${b.api_key_prefix}`);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ bindingId: string }> }) {
  const { bindingId } = await ctx.params;
  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const guard = await requireOrgMember(body.orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  // Make sure the binding belongs to a project of this org.
  const { data: binding } = await svc
    .from('provider_bindings')
    .select('id, project_id, projects!inner(organization_id)')
    .eq('id', bindingId)
    .maybeSingle<{ id: string; project_id: string; projects: { organization_id: string } }>();
  if (!binding || binding.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'binding not found in this org' }, { status: 404 });
  }

  const updates: Record<string, string | null> = {};
  if (body.resource_ref !== undefined) updates.resource_ref = body.resource_ref;
  if (body.display_name !== undefined) updates.display_name = body.display_name;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  }
  const { error } = await svc.from('provider_bindings').update(updates).eq('id', bindingId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await invalidateOrg(guard.orgId);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ bindingId: string }> }) {
  const { bindingId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug) {
    return NextResponse.json({ error: 'orgSlug query param required' }, { status: 400 });
  }
  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { data: binding } = await svc
    .from('provider_bindings')
    .select('id, projects!inner(organization_id)')
    .eq('id', bindingId)
    .maybeSingle<{ id: string; projects: { organization_id: string } }>();
  if (!binding || binding.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'binding not found in this org' }, { status: 404 });
  }

  const { error } = await svc.from('provider_bindings').delete().eq('id', bindingId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await invalidateOrg(guard.orgId);
  return NextResponse.json({ ok: true });
}
