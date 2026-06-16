/**
 * Mint-time risk preview — compute `acceptable` / `inherited` per
 * requested `accepted_risk` × binding, WITHOUT minting anything.
 *
 *   POST /api/v1/tokens/preview
 *     Authorization: Bearer vbn_live_…
 *     body: { projectSlug | projectId, bindings[], accepted_risks[] }
 *
 *   200 PreviewResponse  (lib/mint/risk-preview.ts)
 *
 * Spec : docs/spec/gateway-risk-model.md §9.
 * ADR  : docs/decisions/unified-gates-drop-confirm.md.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireToken } from '@/lib/auth/require-token';
import { computeMintPreview } from '@/lib/mint/preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BindingSchema = z.object({
  provider: z.enum(['github', 'vercel', 'supabase', 'railway', 'bash']),
  resource_ref: z.string().min(1),
  env: z.string().min(1).optional().nullable(),
});

const BodySchema = z.object({
  projectId: z.string().uuid().optional(),
  projectSlug: z.string().min(1).optional(),
  bindings: z.array(BindingSchema).min(1),
  accepted_risks: z.array(z.string().min(1)),
});

interface ProjectRow {
  id: string;
}

export async function POST(req: NextRequest) {
  const guard = await requireToken(req.headers.get('authorization'));
  if (!guard.ok) return guard.response;

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const svc = getSupabaseServiceClient();
  let project: ProjectRow | null = null;
  if (body.projectId) {
    const { data } = await svc
      .from('projects')
      .select('id')
      .eq('organization_id', guard.orgId)
      .eq('id', body.projectId)
      .maybeSingle<ProjectRow>();
    project = data ?? null;
  } else if (body.projectSlug) {
    const { data } = await svc
      .from('projects')
      .select('id')
      .eq('organization_id', guard.orgId)
      .eq('slug', body.projectSlug)
      .maybeSingle<ProjectRow>();
    project = data ?? null;
  } else {
    return NextResponse.json({ error: 'projectId or projectSlug required' }, { status: 400 });
  }
  if (!project) {
    return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
  }

  const preview = computeMintPreview(
    { bindings: body.bindings, accepted_risks: body.accepted_risks },
    guard.token.accepted_risks,
  );

  return NextResponse.json(preview, { status: 200 });
}
