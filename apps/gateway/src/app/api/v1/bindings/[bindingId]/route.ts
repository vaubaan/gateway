/**
 * PATCH  /api/v1/bindings/:bindingId  body: { orgSlug, resource_ref?, display_name?, environment?, env_less_exclude_branch?, env_less_exclude_protected? }
 * DELETE /api/v1/bindings/:bindingId?orgSlug=...
 *
 * Spec : docs/spec/vaubaan-gateway.md §8.3, capability §5.1 #4.
 *
 * `environment` accepts a kebab-case slug or `null` (env-less binding).
 * `env_less_exclude_branch` / `env_less_exclude_protected` are github-only
 * knobs that narrow the fan-out of an env-less grant (the DB CHECK constraint
 * enforces github-only + XOR between the two).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { buildCacheClient } from '@vaubaan/gateway-core';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  orgSlug: z.string().min(1),
  resource_ref: z.string().min(1).optional(),
  display_name: z.string().nullable().optional(),
  environment: z
    .string()
    .regex(
      /^[a-z0-9](-?[a-z0-9])*$/,
      "environment must be lowercase kebab-case (e.g. 'prod', 'staging').",
    )
    .nullable()
    .optional(),
  env_less_exclude_branch: z
    .string()
    .regex(
      /^[a-z0-9](?:[a-z0-9/_-]*[a-z0-9])?$/,
      "env_less_exclude_branch must be a branch slug (e.g. 'main', 'feature/x').",
    )
    .nullable()
    .optional(),
  env_less_exclude_protected: z.boolean().optional(),
});

async function invalidateOrg(orgId: string) {
  const svc = getSupabaseServiceClient();
  const { data: bots } = await svc
    .from('tokens')
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

  const updates: Record<string, string | boolean | null> = {};
  if (body.resource_ref !== undefined) updates.resource_ref = body.resource_ref;
  if (body.display_name !== undefined) updates.display_name = body.display_name;
  if (body.environment !== undefined) updates.environment = body.environment;
  if (body.env_less_exclude_branch !== undefined) {
    updates.env_less_exclude_branch = body.env_less_exclude_branch;
  }
  if (body.env_less_exclude_protected !== undefined) {
    updates.env_less_exclude_protected = body.env_less_exclude_protected;
  }
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
