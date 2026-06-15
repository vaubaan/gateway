/**
 * Poll endpoint — checks the status of a pending mint approval and, when
 * approved, returns the freshly-minted api_key exactly once.
 *
 *   GET /api/v1/mgmt/tokens/pending/:approvalId
 *     Authorization: Bearer vbn_mgmt_…
 *     Query (optional) :
 *       ?wait=<seconds>     long-poll, server blocks up to <seconds> (capped
 *                           at 25 to stay under Vercel Edge / Cloudflare
 *                           proxy timeouts — cf. spec v4 §11). Default 0 =
 *                           legacy single-shot.
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
 * Spec : docs/spec/gateway-risk-model.md §11.
 *
 * Implementation : Node runtime + maxDuration: 30 (headroom above the 25s
 * cap). Inside the wait loop we poll the DB every 500ms — coarse but
 * sufficient at MVP scale. A Postgres LISTEN/NOTIFY upgrade is sketched
 * in the spec but deferred.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireManagementKey } from '@/lib/auth/require-management-key';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Headroom above the 25s wait cap so the platform timeout doesn't preempt
 *  the response. Vercel Pro/Ent allow up to 800s — 30 is comfortable. */
export const maxDuration = 30;

/** Maximum wait the server will honor (seconds). Stays under :
 *   - Vercel Edge runtime cap (25s before first byte) ; we're on Node so
 *     this is informative, not enforced.
 *   - Cloudflare proxy origin idle (100s non-Ent).
 *   - Many enterprise proxies/VPNs (60s default).
 *  The SDK re-polls until its wall-clock budget. */
const MAX_WAIT_SECONDS = 25;
/** Internal poll cadence — coarse but DB-friendly. */
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
  const guard = await requireManagementKey(req.headers.get('authorization'));
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  const svc = getSupabaseServiceClient();

  const waitRaw = req.nextUrl.searchParams.get('wait');
  const waitSeconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, Number(waitRaw) || 0));
  const deadlineMs = waitSeconds > 0 ? Date.now() + waitSeconds * 1000 : 0;

  // First load — authoritative ownership check.
  let row = await loadApprovalRow(svc, id, guard.orgId);
  if (!row) {
    return NextResponse.json({ error: 'approval not found in this org' }, { status: 404 });
  }

  // Long-poll loop : if the caller asked us to wait AND we're still pending
  // AND the approval has not expired, keep re-reading the row at
  // POLL_INTERVAL_MS until status flips or our deadline elapses.
  // W5 — respect client AbortSignal : if the caller disconnects, bail out
  // immediately so we don't waste DB queries on a vanished connection.
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

/**
 * Sleep that resolves early when the provided AbortSignal fires. Lets the
 * long-poll loop short-circuit instead of waiting out a 500ms cadence after
 * the client has already disconnected.
 */
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
