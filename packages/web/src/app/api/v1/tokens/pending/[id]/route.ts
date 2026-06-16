/**
 * Long-poll endpoint — checks the status of a pending mint approval and,
 * when approved, returns the freshly-minted api_key exactly once.
 *
 *   GET /api/v1/tokens/pending/:approvalId
 *     Authorization: Bearer vbn_live_…
 *     Query (optional) :
 *       ?wait=<seconds>     long-poll up to <seconds> (capped at 25)
 *
 *   Responses
 *     - 202 { status: 'pending', expires_at }
 *     - 201 { token, api_key, expires_at }
 *     - 410 { status: 'denied' | 'expired' | 'cancelled' | 'consumed', decided_at? }
 *     - 404
 *
 * Replaces the legacy `/api/v1/mgmt/tokens/pending/[id]` (ADR
 * unified-tokens-delegation-chain-and-escalation-channel.md §D3).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireToken } from '@/lib/auth/require-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_WAIT_SECONDS = 25;
const POLL_INTERVAL_MS = 500;

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
  const guard = await requireToken(req.headers.get('authorization'));
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  const svc = getSupabaseServiceClient();

  const waitRaw = req.nextUrl.searchParams.get('wait');
  const waitSeconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, Number(waitRaw) || 0));
  const deadlineMs = waitSeconds > 0 ? Date.now() + waitSeconds * 1000 : 0;

  let row = await loadApprovalRow(svc, id, guard.orgId);
  if (!row) {
    return NextResponse.json({ error: 'approval not found in this org' }, { status: 404 });
  }

  while (
    waitSeconds > 0 &&
    row !== null &&
    row.status === 'pending' &&
    Date.parse(row.expires_at) > Date.now() &&
    Date.now() < deadlineMs &&
    !req.signal.aborted
  ) {
    await sleep(POLL_INTERVAL_MS, req.signal);
    if (req.signal.aborted) break;
    row = await loadApprovalRow(svc, id, guard.orgId);
  }
  if (!row) {
    return NextResponse.json({ error: 'approval not found in this org' }, { status: 404 });
  }

  if (row.status === 'pending') {
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

  // status === 'approved' : return the api_key once.
  if (!row.access_token_id || !row.pending_api_key) {
    return NextResponse.json(
      { error: 'approval is approved but no api_key is available (state corrupt)' },
      { status: 500 },
    );
  }
  const apiKey = row.pending_api_key;

  const { data: token } = await svc
    .from('tokens')
    .select(
      'id, name, scope, project_id, organization_id, api_key_prefix, status, expires_at, created_at',
    )
    .eq('id', row.access_token_id)
    .maybeSingle<{
      id: string;
      name: string;
      scope: string;
      project_id: string | null;
      organization_id: string;
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
    { token, api_key: apiKey, expires_at: token?.expires_at ?? null },
    { status: 201 },
  );
}

async function loadApprovalRow(
  svc: ReturnType<typeof getSupabaseServiceClient>,
  id: string,
  orgId: string,
): Promise<ApprovalRow | null> {
  const { data: row } = await svc
    .from('approval_requests')
    .select(
      'id, project_id, status, decided_at, expires_at, access_token_id, pending_api_key, projects!inner(organization_id)',
    )
    .eq('id', id)
    .maybeSingle<ApprovalRow>();
  if (!row || row.projects.organization_id !== orgId) return null;
  return row;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(handle);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
