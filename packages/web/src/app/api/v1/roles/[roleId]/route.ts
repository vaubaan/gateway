/**
 * PATCH  /api/v1/roles/:roleId  body: { orgSlug, description?, permissions? }
 * DELETE /api/v1/roles/:roleId?orgSlug=...
 *
 * Custom-only. Builtin roles (organization_id null) are read-only and 403.
 *
 * Spec : docs/spec/vaubaan-gateway.md §8.4.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { PermissionsSchema } from '@vaubaan/policy-engine';
import { buildCacheClient } from '@vaubaan/mcp-gateway';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z
  .object({
    orgSlug: z.string().min(1),
    description: z.string().nullable().optional(),
    permissions: PermissionsSchema.optional(),
  })
  .refine((b) => b.description !== undefined || b.permissions !== undefined, {
    message: 'nothing to update',
  });

async function invalidateOrg(orgId: string): Promise<void> {
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

async function loadCustomRole(svc: ReturnType<typeof getSupabaseServiceClient>, roleId: string) {
  return svc
    .from('roles')
    .select('id, organization_id, is_builtin')
    .eq('id', roleId)
    .maybeSingle<{ id: string; organization_id: string | null; is_builtin: boolean }>();
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ roleId: string }> }) {
  const { roleId } = await ctx.params;
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
  const { data: role } = await loadCustomRole(svc, roleId);
  if (!role) return NextResponse.json({ error: 'role not found' }, { status: 404 });
  if (role.is_builtin || role.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'role is not editable' }, { status: 403 });
  }

  const updates: Record<string, unknown> = {};
  if (body.description !== undefined) updates.description = body.description;
  if (body.permissions !== undefined) updates.permissions = body.permissions;

  const { error } = await svc.from('roles').update(updates).eq('id', roleId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await invalidateOrg(guard.orgId);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ roleId: string }> }) {
  const { roleId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug)
    return NextResponse.json({ error: 'orgSlug query param required' }, { status: 400 });

  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { data: role } = await loadCustomRole(svc, roleId);
  if (!role) return NextResponse.json({ error: 'role not found' }, { status: 404 });
  if (role.is_builtin || role.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'role is not editable' }, { status: 403 });
  }

  // bot_roles has on delete restrict — make sure no bot still references this role.
  const { count } = await svc
    .from('access_token_roles')
    .select('*', { count: 'exact', head: true })
    .eq('role_id', roleId);
  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: `role is in use by ${count} bot(s) — detach them first` },
      { status: 409 },
    );
  }

  const { error } = await svc.from('roles').delete().eq('id', roleId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await invalidateOrg(guard.orgId);
  return NextResponse.json({ ok: true });
}
