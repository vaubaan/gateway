/**
 * EmailChannel — sends an approval request via email with two signed links
 * (approve / deny). The recipient address comes from the project's
 * `project_approval_channels.email_address` row.
 *
 * Spec : docs/spec/gateway-risk-model.md §7.1, §10.
 *
 * Email delivery uses the Resend HTTP API directly (no SDK dependency).
 * `RESEND_API_KEY` is required at runtime ; absence is a hard error at
 * `open()` so the channel can fall back to manual in `pickChannel`.
 */

import type { ApprovalChannel, ApprovalChannelDispatched, ApprovalRequestPayload } from './channel';
import { signEmailToken } from './email-token';

export interface EmailChannelConfig {
  /** RESEND_API_KEY. Required. */
  readonly apiKey: string;
  /** From: header. Falls back to `EMAIL_FROM_ADDRESS` env var. */
  readonly from: string;
  /** Public base URL of the gateway (https://gateway.vaubaan.dev). The two
   *  approve/deny links are built from this base + the token. */
  readonly baseUrl: string;
  /** HMAC secret used to sign the per-link token. Falls back to
   *  `EMAIL_SIGNING_SECRET` env var. */
  readonly signingSecret: string;
  /** Recipient email address — comes from `project_approval_channels`. */
  readonly recipient: string;
}

export class EmailChannel implements ApprovalChannel {
  readonly id = 'email' as const;

  constructor(private readonly cfg: EmailChannelConfig) {}

  async open(req: ApprovalRequestPayload): Promise<ApprovalChannelDispatched> {
    const expiresAt = Math.floor(Date.now() / 1000) + req.ttlHours * 3600;
    const approveToken = await signEmailToken(
      { approvalId: req.approvalId, decision: 'approve', exp: expiresAt },
      this.cfg.signingSecret,
    );
    const denyToken = await signEmailToken(
      { approvalId: req.approvalId, decision: 'deny', exp: expiresAt },
      this.cfg.signingSecret,
    );

    const approveUrl = `${this.cfg.baseUrl}/api/v1/integrations/email/decide?token=${approveToken}`;
    const denyUrl = `${this.cfg.baseUrl}/api/v1/integrations/email/decide?token=${denyToken}`;

    const subject = `[Vaubaan] Approval requested — ${req.projectName ?? req.projectId}`;
    const html = renderHtml(req, approveUrl, denyUrl);
    const text = renderText(req, approveUrl, denyUrl);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.cfg.from,
        to: [this.cfg.recipient],
        subject,
        html,
        text,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(
        `EmailChannel: Resend rejected the send (HTTP ${res.status}): ${detail.slice(0, 200)}`,
      );
    }

    return { channelRef: this.cfg.recipient };
  }
}

function renderRisks(req: ApprovalRequestPayload): {
  needsApprovalLine: string;
  acceptedLine: string;
} {
  const accepted = (req.acceptedRisks ?? []).filter((r) => !(req.needsApproval ?? []).includes(r));
  return {
    needsApprovalLine: (req.needsApproval ?? []).join(', ') || '(none)',
    acceptedLine: accepted.join(', ') || '(none)',
  };
}

function renderText(req: ApprovalRequestPayload, approveUrl: string, denyUrl: string): string {
  const { needsApprovalLine, acceptedLine } = renderRisks(req);
  const ctxJson = req.context ? JSON.stringify(req.context, null, 2) : '';
  return [
    `[Vaubaan] Approval requested for project "${req.projectName ?? req.projectId}"`,
    ``,
    `Token name : ${req.tokenName}`,
    `TTL        : ${req.ttlHours}h`,
    ``,
    `Risks needing your confirmation :`,
    `  ${needsApprovalLine}`,
    ``,
    `Other risks already accepted (allow) :`,
    `  ${acceptedLine}`,
    ``,
    ctxJson ? `Context :\n${ctxJson}\n` : '',
    `▸ APPROVE : ${approveUrl}`,
    `▸ DENY    : ${denyUrl}`,
    ``,
    `The links expire in ${req.ttlHours}h.`,
  ].join('\n');
}

function renderHtml(req: ApprovalRequestPayload, approveUrl: string, denyUrl: string): string {
  const { needsApprovalLine, acceptedLine } = renderRisks(req);
  const ctxJson = req.context
    ? `<pre style="background:#f5f5f5;padding:8px;border-radius:4px;font-size:12px;overflow:auto">${escapeHtml(
        JSON.stringify(req.context, null, 2),
      )}</pre>`
    : '';
  return `
<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin:0 0 16px 0">Approval requested</h2>
  <p style="margin:0 0 8px 0"><strong>Project</strong> : ${escapeHtml(req.projectName ?? req.projectId)}</p>
  <p style="margin:0 0 8px 0"><strong>Token</strong> : ${escapeHtml(req.tokenName)} (${req.ttlHours}h TTL)</p>
  <h3 style="margin:24px 0 8px 0;color:#b45309">⚠ Risks needing your confirmation</h3>
  <p style="margin:0 0 16px 0"><code>${escapeHtml(needsApprovalLine)}</code></p>
  <h3 style="margin:24px 0 8px 0;color:#15803d">✓ Other risks accepted (allow)</h3>
  <p style="margin:0 0 16px 0"><code>${escapeHtml(acceptedLine)}</code></p>
  ${ctxJson}
  <div style="margin:32px 0;display:flex;gap:12px">
    <a href="${approveUrl}" style="background:#15803d;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">✅ APPROVE</a>
    <a href="${denyUrl}" style="background:#dc2626;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">❌ DENY</a>
  </div>
  <p style="font-size:12px;color:#666;margin-top:32px">The links above expire in ${req.ttlHours}h.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
