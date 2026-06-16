/**
 * Approve / deny a pending mint approval — Bearer-authenticated path.
 *
 *   POST /api/v1/mgmt/approvals/:approvalId
 *     Authorization: Bearer vbn_live_…   (operator's token in the same org)
 *     body: { decision: 'approve' | 'deny', decidedBy?: string }
 *
 * Mirrors the user-session decide route ; the legacy `vbn_mgmt_*` prefix is
 * gone (ADR unified-tokens-delegation-chain-and-escalation-channel.md).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { RiskId } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireToken } from '@/lib/auth/require-token';
import { decideApproval, type MintParent } from '@/lib/approvals/mint';
import { loadParentTokenForApproval } from '@/lib/approvals/load-parent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  decision: z.enum(['approve', 'deny']),
  decidedBy: z.string().min(1).optional(),
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

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireToken(req.headers.get('authorization'));
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;

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

  const { data: row } = await svc
    .from('approval_requests')
    .select(
      'id, project_id, status, requested_risks, requested_token_name, requested_ttl_hours, requested_single_use, context, projects!inner(organization_id)',
    )
    .eq('id', id)
    .maybeSingle<ApprovalRow>();
  if (!row || row.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'approval not found in this org' }, { status: 404 });
  }
  if (row.status !== 'pending') {
    return NextResponse.json(
      { error: `approval is no longer pending (status=${row.status})` },
      { status: 409 },
    );
  }

  const parent: MintParent = await loadParentTokenForApproval(svc, row.id, guard.token);

  const result = await decideApproval(svc, {
    approvalId: row.id,
    decision: body.decision,
    decidedBy: body.decidedBy ?? `token:${guard.token.id}`,
    parent,
    scope: 'project',
    projectId: row.project_id,
    acceptedRisks: row.requested_risks ?? [],
    deniedRisks: [],
    tokenName: row.requested_token_name,
    ttlHours: row.requested_ttl_hours,
    singleUse: row.requested_single_use,
    context: row.context,
    createdBy: null,
  });

  return NextResponse.json({ status: result.status }, { status: 200 });
}
