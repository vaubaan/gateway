/**
 * Per-project policy_rules CRUD — user-session authenticated.
 *
 *   GET    /api/v1/projects/:projectId/policy?orgSlug=…    → list rules
 *   POST   /api/v1/projects/:projectId/policy              → create rule
 *
 * Spec : docs/spec/gateway-capability-model.md §5.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { PolicyRule } from '@vaubaan/policy-engine';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SLUG_OR_WILDCARD = /^(\*|[a-z][a-z0-9-]*)$/;
const ENV_OR_WILDCARD = /^(\*|[a-z0-9](?:[a-z0-9/_-]*[a-z0-9])?)$/;

const CreateBodySchema = z.object({
  orgSlug: z.string().min(1),
  provider: z.string().regex(SLUG_OR_WILDCARD),
  plane: z.string().regex(SLUG_OR_WILDCARD),
  level: z.string().regex(SLUG_OR_WILDCARD),
  action: z.enum(['read', 'write', '*']),
  env_pattern: z.string().regex(ENV_OR_WILDCARD),
  gate: z.enum(['allow', 'confirm', 'deny']),
  priority: z.number().int().min(0).max(10000).default(100),
});

async function guardProject(projectId: string, orgSlug: string) {
  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return { ok: false as const, response: guard.response };
  const svc = getSupabaseServiceClient();
  const { data: project } = await svc
    .from('projects')
    .select('id, organization_id')
    .eq('id', projectId)
    .maybeSingle<{ id: string; organization_id: string }>();
  if (!project || project.organization_id !== guard.orgId) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: 'project not found in this org' }, { status: 404 }),
    };
  }
  return { ok: true as const, svc, projectId: project.id, guard };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug)
    return NextResponse.json({ error: 'orgSlug query param required' }, { status: 400 });
  const g = await guardProject(projectId, orgSlug);
  if (!g.ok) return g.response;
  const { data } = await g.svc
    .from('policy_rules')
    .select('id, project_id, provider, plane, level, action, env_pattern, gate, priority')
    .eq('project_id', projectId)
    .order('priority', { ascending: false })
    .returns<PolicyRule[]>();
  return NextResponse.json({ rules: data ?? [] }, { status: 200 });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  let body: z.infer<typeof CreateBodySchema>;
  try {
    body = CreateBodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }
  // Defensive : reject the §5.1 anti-pattern at API level (SQL CHECK already
  // does it, but a clean 400 is friendlier than a 500).
  if (body.action === 'write' && body.env_pattern === '*' && body.gate === 'allow') {
    return NextResponse.json(
      {
        error:
          'blanket allow on writes is forbidden (env_pattern=* + action=write + gate=allow). Scope the env_pattern.',
      },
      { status: 400 },
    );
  }
  const g = await guardProject(projectId, body.orgSlug);
  if (!g.ok) return g.response;
  const { data, error } = await g.svc
    .from('policy_rules')
    .insert({
      project_id: projectId,
      provider: body.provider,
      plane: body.plane,
      level: body.level,
      action: body.action,
      env_pattern: body.env_pattern,
      gate: body.gate,
      priority: body.priority,
    })
    .select('id, project_id, provider, plane, level, action, env_pattern, gate, priority')
    .single<PolicyRule>();
  if (error || !data)
    return NextResponse.json(
      { error: error?.message ?? 'failed to insert policy rule' },
      { status: 500 },
    );
  return NextResponse.json({ rule: data }, { status: 201 });
}
