/**
 * PATCH  /api/v1/orgs/:slug  body: { name?, slug? }
 * DELETE /api/v1/orgs/:slug
 *
 * Owner-only. Rename can update name and/or slug. Delete cascades to projects,
 * provider_admins, provider_bindings, access_tokens, audit_log (cf. supabase
 * migration 0001_init.sql).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { MemoryCacheClient } from '@vaubaan/gateway-core';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgOwner } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z
  .object({
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

async function invalidateOrg(orgId: string) {
  const svc = getSupabaseServiceClient();
  const { data: tokens } = await svc
    .from('tokens')
    .select('api_key_prefix, projects!inner(organization_id)')
    .eq('projects.organization_id', orgId);
  const cache = new MemoryCacheClient();
  for (const t of (tokens ?? []) as Array<{ api_key_prefix: string }>) {
    await cache.del(`vaubaan:ctx:${t.api_key_prefix}`);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }
  const guard = await requireOrgOwner(slug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();

  if (body.slug && body.slug !== slug) {
    const { data: dup } = await svc
      .from('organizations')
      .select('id')
      .eq('slug', body.slug)
      .maybeSingle<{ id: string }>();
    if (dup) {
      return NextResponse.json({ error: 'slug already taken' }, { status: 409 });
    }
  }

  const updates: Record<string, string> = {};
  if (body.name) updates.name = body.name;
  if (body.slug) updates.slug = body.slug;
  const { error } = await svc.from('organizations').update(updates).eq('id', guard.orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, slug: body.slug ?? slug });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const guard = await requireOrgOwner(slug);
  if (!guard.ok) return guard.response;

  // Invalidate token caches before the cascade wipes them.
  await invalidateOrg(guard.orgId);

  const svc = getSupabaseServiceClient();
  const { error } = await svc.from('organizations').delete().eq('id', guard.orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
