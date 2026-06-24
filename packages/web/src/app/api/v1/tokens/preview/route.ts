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
  provider: z.enum(['github', 'vercel', 'supabase', 'railway', 'bash', 'stripe', 'resend']),
  resource_ref: z.string().min(1),
  env: z.string().min(1).optional().nullable(),
});

const BodySchema = z.object({
  projectId: z.string().uuid().optional(),
  projectSlug: z.string().min(1).optional(),
  bindings: z.array(BindingSchema).min(1),
  accepted_risks: z.array(z.string().min(1)),
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

  const svc = getSupabaseServiceClient();

  // Resolve the org of the target project so the session-fallback can
  // enforce membership. The auth boundary then re-verifies the project
  // belongs to that org via the same lookup below.
  let projectOrgId: string | null = null;
  if (body.projectId) {
    const { data } = await svc
      .from('projects')
      .select('organization_id')
      .eq('id', body.projectId)
      .maybeSingle<{ organization_id: string }>();
    projectOrgId = data?.organization_id ?? null;
  } else if (body.projectSlug) {
    const { data } = await svc
      .from('projects')
      .select('organization_id')
      .eq('slug', body.projectSlug)
      .maybeSingle<{ organization_id: string }>();
    projectOrgId = data?.organization_id ?? null;
  } else {
    return NextResponse.json({ error: 'projectId or projectSlug required' }, { status: 400 });
  }

  const guard = await requireToken(req.headers.get('authorization'), {
    allowSessionFallback: projectOrgId ? { orgId: projectOrgId } : undefined,
  });
  if (!guard.ok) return guard.response;

  // Re-verify the project exists in the caller's org. The select(head:true)
  // serves only as an existence + auth guard ; the preview is binding-driven
  // (no project id needed downstream).
  let exists = false;
  if (body.projectId) {
    const { count } = await svc
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', guard.orgId)
      .eq('id', body.projectId);
    exists = (count ?? 0) > 0;
  } else if (body.projectSlug) {
    const { count } = await svc
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', guard.orgId)
      .eq('slug', body.projectSlug);
    exists = (count ?? 0) > 0;
  }
  if (!exists) {
    return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
  }

  // In bearer mode (child mint), the inherited check uses the parent's
  // accepted_risks. In session mode (root mint), there's no parent —
  // pass null so every risk row is reported as inherited at preview time.
  const parentRisksForPreview = guard.mode === 'bearer' ? guard.token.accepted_risks : null;

  const preview = computeMintPreview(
    { bindings: body.bindings, accepted_risks: body.accepted_risks },
    parentRisksForPreview,
  );

  return NextResponse.json(preview, { status: 200 });
}
