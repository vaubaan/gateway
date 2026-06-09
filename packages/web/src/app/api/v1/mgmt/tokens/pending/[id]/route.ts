/**
 * Poll endpoint — checks the status of a pending mint approval and, when
 * approved, returns the freshly-minted api_key exactly once.
 *
 *   GET /api/v1/mgmt/tokens/pending/:approvalId
 *     Authorization: Bearer vbn_mgmt_…
 *
 *   Responses
 *     - 202 { status: 'pending', expires_at }                       still waiting
 *     - 201 { access_token, api_key, expires_at }                   approved, consumed now
 *     - 410 { status: 'denied' | 'expired' | 'cancelled' | 'consumed', decided_at? }
 *     - 404                                                          not found in this org
 *
 * The api_key is shown ONCE — after the first successful poll, the row's
 * status flips to 'consumed' and `pending_api_key` is cleared.
 *
 * Spec : docs/spec/gateway-capability-model.draft.md §8.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireManagementKey } from '@/lib/auth/require-management-key';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ApprovalRow {
  id: string;
  project_id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'consumed';
  decided_at: string | null;
  expires_at: string;
  access_token_id: string | null;
  pending_api_key: string | null;
  projects: { organization_id: string };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireManagementKey(req.headers.get('authorization'));
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  const svc = getSupabaseServiceClient();

  const { data: row } = await svc
    .from('approval_requests')
    .select(
      'id, project_id, status, decided_at, expires_at, access_token_id, pending_api_key, projects!inner(organization_id)',
    )
    .eq('id', id)
    .maybeSingle<ApprovalRow>();
  if (!row || row.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'approval not found in this org' }, { status: 404 });
  }

  if (row.status === 'pending') {
    // Server-side TTL check : if past expires_at, flip to 'expired' lazily.
    if (Date.parse(row.expires_at) < Date.now()) {
      await svc
        .from('approval_requests')
        .update({ status: 'expired', decided_at: new Date().toISOString() })
        .eq('id', row.id);
      return NextResponse.json(
        { status: 'expired', decided_at: new Date().toISOString() },
        { status: 410 },
      );
    }
    return NextResponse.json({ status: 'pending', expires_at: row.expires_at }, { status: 202 });
  }

  if (
    row.status === 'denied' ||
    row.status === 'expired' ||
    row.status === 'cancelled' ||
    row.status === 'consumed'
  ) {
    return NextResponse.json({ status: row.status, decided_at: row.decided_at }, { status: 410 });
  }

  // status === 'approved' : return the api_key once, mark consumed, clear.
  if (!row.access_token_id || !row.pending_api_key) {
    return NextResponse.json(
      { error: 'approval is approved but no api_key is available (state corrupt)' },
      { status: 500 },
    );
  }
  const apiKey = row.pending_api_key;

  const { data: token } = await svc
    .from('access_tokens')
    .select('id, name, project_id, api_key_prefix, status, expires_at, created_at')
    .eq('id', row.access_token_id)
    .maybeSingle<{
      id: string;
      name: string;
      project_id: string;
      api_key_prefix: string;
      status: string;
      expires_at: string;
      created_at: string;
    }>();

  await svc
    .from('approval_requests')
    .update({
      status: 'consumed',
      consumed_at: new Date().toISOString(),
      pending_api_key: null,
    })
    .eq('id', row.id);

  return NextResponse.json(
    { access_token: token, api_key: apiKey, expires_at: token?.expires_at ?? null },
    { status: 201 },
  );
}
