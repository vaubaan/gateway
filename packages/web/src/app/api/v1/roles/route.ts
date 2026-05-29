/**
 * POST /api/v1/roles  body: { orgSlug, name, provider, description?, permissions }
 *
 * Creates a custom (org-scoped) role. The role name must be prefixed with
 * the provider per ADR roles-naming-provider-scoped.md.
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

const BodySchema = z
  .object({
    orgSlug: z.string().min(1),
    provider: z.enum(['github', 'vercel', 'supabase']),
    name: z.string().regex(/^(github|vercel|supabase):[a-z0-9](-?[a-z0-9])*$/i),
    description: z.string().nullable().optional(),
    permissions: PermissionsSchema,
  })
  .refine((b) => b.name.startsWith(b.provider + ':'), {
    message: 'role name must be prefixed with `<provider>:`',
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

export async function POST(req: NextRequest) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const guard = await requireOrgMember(body.orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { data, error } = await svc
    .from('roles')
    .insert({
      organization_id: guard.orgId,
      provider: body.provider,
      name: body.name,
      description: body.description ?? null,
      is_builtin: false,
      permissions: body.permissions,
    })
    .select('id')
    .single<{ id: string }>();
  if (error || !data)
    return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 });

  await invalidateOrg(guard.orgId);
  return NextResponse.json({ id: data.id }, { status: 201 });
}
