/**
 * User-session mint preview — compute the effective gate per
 * (accepted_risk × binding) without minting.
 *
 *   POST /api/v1/projects/:projectId/mint/preview
 *     Cookie:  Supabase Auth session
 *     Body  :  { orgSlug, bindings[], accepted_risks[], denied_risks? }
 *
 *   200  PreviewResponse  (same shape as the mgmt route)
 *
 * The user must be a member of the org that owns the project (cf.
 * `requireOrgMember`). The actual gate computation is delegated to the
 * shared `computeMintPreview` helper.
 *
 * Spec : docs/spec/gateway-risk-model.md §9.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { computeMintPreview } from '@/lib/mint/preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BindingSchema = z.object({
  provider: z.enum(['github', 'vercel', 'supabase', 'railway', 'bash']),
  resource_ref: z.string().min(1),
  env: z.string().min(1).optional().nullable(),
});

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  bindings: z.array(BindingSchema).min(1),
  accepted_risks: z.array(z.string().min(1)),
  denied_risks: z.array(z.string().min(1)).optional(),
});

interface ProjectRow {
  id: string;
  organization_id: string;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;

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

  // Ownership check : the project must belong to the user's org.
  const svc = getSupabaseServiceClient();
  const { data: project } = await svc
    .from('projects')
    .select('id, organization_id')
    .eq('id', projectId)
    .maybeSingle<ProjectRow>();
  if (!project || project.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
  }

  const preview = await computeMintPreview(svc, project.id, {
    bindings: body.bindings.map((b) => ({
      provider: b.provider,
      resource_ref: b.resource_ref,
      env: b.env ?? null,
    })),
    accepted_risks: body.accepted_risks,
    denied_risks: body.denied_risks,
  });

  return NextResponse.json(preview, { status: 200 });
}
