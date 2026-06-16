/**
 * Email approval decide endpoint.
 *
 *   GET /api/v1/integrations/email/decide?token=<signed-token>
 *
 * Spec : docs/spec/gateway-risk-model.md §7.1, §10.
 *
 * The token is HMAC-signed with `EMAIL_SIGNING_SECRET` and embeds the
 * approval id + intended decision (`approve` | `deny`) + expiry. We verify,
 * load the approval row, and call `decideApproval`. Then we redirect to a
 * public confirmation page.
 *
 * The endpoint is GET (rather than POST) so the email client can hit it
 * with a click. CSRF is mitigated by the HMAC signature : an attacker who
 * doesn't know the secret cannot forge a valid token for an approval id.
 */

import { type NextRequest } from 'next/server';
import type { RiskId } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { decideApproval } from '@/lib/approvals/mint';
import { externalApprovalParent } from '@/lib/approvals/external-mint';
import { verifyEmailToken, EmailTokenError } from '@/lib/approvals/email-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ApprovalRow {
  id: string;
  project_id: string;
  status: string;
  requested_risks: RiskId[] | null;
  denied_risks: RiskId[] | null;
  requested_token_name: string;
  requested_ttl_hours: number;
  requested_single_use: boolean;
  channel: string;
  context: Record<string, unknown> | null;
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) return errorPage('Missing token', 400);

  const secret = process.env.EMAIL_SIGNING_SECRET;
  if (!secret) {
    console.error('[email-decide] EMAIL_SIGNING_SECRET is not set');
    return errorPage('Email approval is not configured on this server', 500);
  }

  let payload;
  try {
    payload = await verifyEmailToken(token, secret);
  } catch (e) {
    if (e instanceof EmailTokenError) {
      if (e.code === 'expired') return errorPage('This approval link has expired', 410);
      return errorPage('This approval link is invalid', 400);
    }
    return errorPage('Unable to verify the approval link', 500);
  }

  const svc = getSupabaseServiceClient();
  const { data: row } = await svc
    .from('approval_requests')
    .select(
      'id, project_id, status, requested_risks, denied_risks, requested_token_name, requested_ttl_hours, requested_single_use, channel, context',
    )
    .eq('id', payload.approvalId)
    .maybeSingle<ApprovalRow>();
  if (!row) return errorPage('Approval not found', 404);
  if (row.channel !== 'email') return errorPage('This approval is not bound to email', 400);
  if (row.status !== 'pending') {
    return resultPage(payload.decision, `already ${row.status}`, row.status);
  }

  const decidedBy = `email:${maskEmailFromHeaders(req)}`;

  try {
    // Email-click flow has no authenticated parent token ; synthesize a
    // carte-blanche root parent (cf. lib/approvals/external-mint.ts).
    // Resolve the org via the project join (we have project_id on the row).
    const { data: project } = await svc
      .from('projects')
      .select('organization_id')
      .eq('id', row.project_id)
      .maybeSingle<{ organization_id: string }>();
    const parent = externalApprovalParent({
      approvalId: row.id,
      organizationId: project?.organization_id ?? '',
      channel: 'email',
      createdBy: null,
    });
    await decideApproval(svc, {
      approvalId: payload.approvalId,
      decision: payload.decision,
      decidedBy,
      parent,
      scope: 'project',
      projectId: row.project_id,
      acceptedRisks: row.requested_risks ?? [],
      deniedRisks: row.denied_risks ?? [],
      tokenName: row.requested_token_name,
      ttlHours: row.requested_ttl_hours,
      singleUse: row.requested_single_use,
      context: row.context,
    });
  } catch (e) {
    console.error('[email-decide] decideApproval failed', e);
    return errorPage('Failed to record the decision — try again', 500);
  }

  return resultPage(
    payload.decision,
    decidedBy,
    payload.decision === 'approve' ? 'approved' : 'denied',
  );
}

function maskEmailFromHeaders(req: NextRequest): string {
  // We have no authoritative recipient identity at click-time. Use the
  // X-Forwarded-For + User-Agent fingerprint as a coarse decided_by trail.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  return ip;
}

function htmlPage(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:80px auto;padding:24px;color:#111;text-align:center}
h1{margin:0 0 16px 0;font-size:22px} p{margin:8px 0;color:#444}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function resultPage(decision: 'approve' | 'deny', _decidedBy: string, status: string): Response {
  const icon = decision === 'approve' ? '✅' : '❌';
  const verb = decision === 'approve' ? 'approved' : 'denied';
  return htmlPage(
    `${icon} ${verb}`,
    `<h1>${icon} Approval ${escapeHtml(verb)}</h1>
     <p>Status : <strong>${escapeHtml(status)}</strong></p>
     <p>You can close this tab.</p>`,
    200,
  );
}

function errorPage(msg: string, status: number): Response {
  return htmlPage(
    `Approval — ${status}`,
    `<h1>Cannot process this approval</h1><p>${escapeHtml(msg)}</p>`,
    status,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
