import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { generateApiKey, hashApiKey } from '@vauban/shared';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  projectSlug: z.string().min(1),
  name: z.string().regex(/^[a-z0-9](-?[a-z0-9])*$/),
  roleIds: z.array(z.string().uuid()).min(1),
});

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  // Resolve org + project + admin check.
  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug')
    .eq('slug', body.orgSlug)
    .maybeSingle<{ id: string; slug: string }>();
  if (!org) return NextResponse.json({ error: 'org not found' }, { status: 404 });
  const o = org;

  const { data: member } = await supabase
    .from('org_members')
    .select('role')
    .eq('organization_id', o.id)
    .eq('user_id', user.user.id)
    .maybeSingle<{ role: 'member' | 'admin' }>();
  if (!member || member.role !== 'admin') {
    return NextResponse.json({ error: 'admin role required' }, { status: 403 });
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id, slug')
    .eq('organization_id', o.id)
    .eq('slug', body.projectSlug)
    .maybeSingle<{ id: string; slug: string }>();
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  const p = project;

  // Generate api_key + hash. Service client to bypass RLS for the insert chain.
  const { apiKey, apiKeyPrefix } = generateApiKey('live');
  const apiKeyHash = await hashApiKey(apiKey);

  const svc = getSupabaseServiceClient();

  const { data: inserted, error: botErr } = await svc
    .from('bots')
    .insert({
      project_id: p.id,
      name: body.name,
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      status: 'active',
      created_by: user.user.id,
    })
    .select('id, name, api_key_prefix, status, created_at')
    .single<{
      id: string;
      name: string;
      api_key_prefix: string;
      status: string;
      created_at: string;
    }>();
  if (botErr || !inserted) {
    return NextResponse.json({ error: botErr?.message ?? 'failed to insert bot' }, { status: 500 });
  }
  const bot = inserted;

  const { error: linkErr } = await svc
    .from('bot_roles')
    .insert(body.roleIds.map((roleId) => ({ bot_id: bot.id, role_id: roleId })));
  if (linkErr) {
    return NextResponse.json({ error: linkErr.message }, { status: 500 });
  }

  return NextResponse.json({ bot: inserted, api_key: apiKey }, { status: 201 });
}
