/**
 * Approve / deny a pending mint approval — user-session-authenticated path.
 *
 *   POST /api/v1/projects/:projectId/approvals/:approvalId/decide
 *     body: { orgSlug, decision: 'approve' | 'deny' }
 *
 * Mirrors the mgmt-key version (/api/v1/mgmt/approvals/:id) but uses an
 * org-member session instead of a vbn_mgmt_… key, so the dashboard can
 * surface the action inline.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { RiskId } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { decideApproval } from '@/lib/approvals/mint';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  decision: z.enum(['approve', 'deny']),
});

interface ApprovalRow {
  id: string;
  project_id: string;
  status: string;
  requested_risks: RiskId[] | null;
  requested_token_name: string;
  requested_ttl_hours: number;
  requested_single_use: boolean;
  context: Record<string, unknown> | null;
  projects: { organization_id: string };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; approvalId: string }> },
) {
  const { projectId, approvalId } = await ctx.params;
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
  const { data: row } = await svc
    .from('approval_requests')
    .select(
      'id, project_id, status, requested_risks, requested_token_name, requested_ttl_hours, requested_single_use, context, projects!inner(organization_id)',
    )
    .eq('id', approvalId)
    .eq('project_id', projectId)
    .maybeSingle<ApprovalRow>();
  if (!row || row.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'approval not found in this project' }, { status: 404 });
  }
  if (row.status !== 'pending') {
    return NextResponse.json(
      { error: `approval is no longer pending (status=${row.status})` },
      { status: 409 },
    );
  }

  // User-session approval flow : synthesize a carte-blanche root parent so
  // the mint goes through (org member is authorized — subset check bypassed).
  const carteBlancheParent = {
    id: row.id,
    name: 'user-session-approval',
    organization_id: guard.orgId,
    scope: 'org' as const,
    project_id: null,
    accepted_risks: [],
    denied_risks: [],
    depth: 0,
    delegation_chain: [],
    expires_at: null,
    created_at: new Date().toISOString(),
    created_by: guard.userId,
  };

  const result = await decideApproval(svc, {
    approvalId: row.id,
    decision: body.decision,
    decidedBy: `user:${guard.userId}`,
    parent: carteBlancheParent,
    scope: 'project',
    projectId: row.project_id,
    acceptedRisks: row.requested_risks ?? [],
    deniedRisks: [],
    tokenName: row.requested_token_name,
    ttlHours: row.requested_ttl_hours,
    singleUse: row.requested_single_use,
    context: row.context,
    createdBy: guard.userId,
  });

  return NextResponse.json({ status: result.status }, { status: 200 });
}
