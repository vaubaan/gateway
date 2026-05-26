import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { generateApiKey, hashApiKey } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  projectSlug: z.string().min(1),
  name: z.string().regex(/^[a-z0-9](-?[a-z0-9])*$/),
  roleIds: z.array(z.string().uuid()).min(1),
});

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

  const { data: project } = await svc
    .from('projects')
    .select('id, slug')
    .eq('organization_id', guard.orgId)
    .eq('slug', body.projectSlug)
    .maybeSingle<{ id: string; slug: string }>();
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  const p = project;

  const { apiKey, apiKeyPrefix } = generateApiKey('live');
  const apiKeyHash = await hashApiKey(apiKey);

  const { data: inserted, error: insertErr } = await svc
    .from('access_tokens')
    .insert({
      project_id: p.id,
      name: body.name,
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      status: 'active',
      created_by: guard.userId,
    })
    .select('id, name, api_key_prefix, status, created_at')
    .single<{
      id: string;
      name: string;
      api_key_prefix: string;
      status: string;
      created_at: string;
    }>();
  if (insertErr || !inserted) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'failed to insert access token' },
      { status: 500 },
    );
  }
  const token = inserted;

  const { error: linkErr } = await svc
    .from('access_token_roles')
    .insert(body.roleIds.map((roleId) => ({ access_token_id: token.id, role_id: roleId })));
  if (linkErr) {
    return NextResponse.json({ error: linkErr.message }, { status: 500 });
  }

  return NextResponse.json({ access_token: inserted, api_key: apiKey }, { status: 201 });
}
