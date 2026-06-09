/**
 * Approve / deny a pending mint approval — operator-facing endpoint.
 *
 *   POST /api/v1/mgmt/approvals/:approvalId
 *     Authorization: Bearer vbn_mgmt_…  (operator's mgmt key in the same org)
 *     body: { decision: 'approve' | 'deny', decidedBy?: string }
 *
 *   Responses
 *     - 200 { status: 'approved' | 'denied' }
 *     - 409 { error }   when the row is no longer pending
 *     - 404             not found in this org
 *
 * On approve : mints the access token *now* with the originally-requested
 * caps/ttl/name and stashes the api_key on the approval row. The caller (the
 * original requester, polling /pending/:id) picks it up on its next poll and
 * clears it.
 *
 * Telegram webhook handler reuses the same internal logic through
 * `decideApproval` — see /api/v1/integrations/telegram/webhook.
 *
 * Spec : docs/spec/gateway-capability-model.md §8.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { Capability } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireManagementKey } from '@/lib/auth/require-management-key';
import { decideApproval } from '@/lib/approvals/decide';

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
  requested_capabilities: Capability[];
  requested_token_name: string;
  requested_ttl_hours: number;
  requested_single_use: boolean;
  projects: { organization_id: string };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireManagementKey(req.headers.get('authorization'));
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
      'id, project_id, status, requested_capabilities, requested_token_name, requested_ttl_hours, requested_single_use, projects!inner(organization_id)',
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

  const result = await decideApproval(svc, {
    approvalId: row.id,
    decision: body.decision,
    decidedBy: body.decidedBy ?? `mgmt:${guard.managementKeyId}`,
    projectId: row.project_id,
    capabilities: row.requested_capabilities,
    tokenName: row.requested_token_name,
    ttlHours: row.requested_ttl_hours,
    singleUse: row.requested_single_use,
  });

  return NextResponse.json({ status: result.status }, { status: 200 });
}
