/**
 * PATCH  /api/v1/projects/:projectId  body: { orgSlug, name?, slug? }
 * DELETE /api/v1/projects/:projectId?orgSlug=...
 *
 * DELETE cascades to bindings + access_tokens + access_token_roles (cf. supabase
 * migration 0001_init.sql).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { buildCacheClient } from '@vaubaan/mcp-gateway';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z
  .object({
    orgSlug: z.string().min(1),
    name: z.string().min(1).max(120).optional(),
    slug: z
      .string()
      .regex(/^[a-z0-9](-?[a-z0-9])*$/, 'slug must be lowercase kebab-case')
      .min(2)
      .max(40)
      .optional(),
  })
  .refine((b) => b.name !== undefined || b.slug !== undefined, {
    message: 'nothing to update',
  });

async function invalidateProject(projectId: string): Promise<void> {
  const svc = getSupabaseServiceClient();
  const { data: bots } = await svc
    .from('access_tokens')
    .select('api_key_prefix')
    .eq('project_id', projectId);
  const cache = buildCacheClient();
  for (const b of (bots ?? []) as Array<{ api_key_prefix: string }>) {
    await cache.del(`vaubaan:ctx:${b.api_key_prefix}`);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
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
  const { data: project } = await svc
    .from('projects')
    .select('id, organization_id, slug')
    .eq('id', projectId)
    .maybeSingle<{ id: string; organization_id: string; slug: string }>();
  if (!project || project.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'project not found' }, { status: 404 });
  }

  if (body.slug && body.slug !== project.slug) {
    const { data: dup } = await svc
      .from('projects')
      .select('id')
      .eq('organization_id', guard.orgId)
      .eq('slug', body.slug)
      .maybeSingle<{ id: string }>();
    if (dup) return NextResponse.json({ error: 'slug already taken' }, { status: 409 });
  }

  const updates: Record<string, string> = {};
  if (body.name) updates.name = body.name;
  if (body.slug) updates.slug = body.slug;
  const { error } = await svc.from('projects').update(updates).eq('id', projectId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, slug: body.slug ?? project.slug });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug)
    return NextResponse.json({ error: 'orgSlug query param required' }, { status: 400 });
  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { data: project } = await svc
    .from('projects')
    .select('id, organization_id')
    .eq('id', projectId)
    .maybeSingle<{ id: string; organization_id: string }>();
  if (!project || project.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'project not found' }, { status: 404 });
  }

  await invalidateProject(projectId);
  const { error } = await svc.from('projects').delete().eq('id', projectId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
