/**
 * Approval channel registry + factory.
 *
 * Reads the project's `project_approval_channels` row to pick the impl ; falls
 * back to ManualChannel when no row exists. The factory is async because the
 * channel may need to load credentials from the DB.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ManualChannel } from './manual';
import { TelegramChannel } from './telegram';
import { EmailChannel } from './email';
import type { ApprovalChannel } from './channel';

export type { ApprovalChannel, ApprovalRequestPayload } from './channel';
export { ManualChannel } from './manual';
export { TelegramChannel } from './telegram';
export { EmailChannel } from './email';

interface ChannelRow {
  channel: 'manual' | 'telegram' | 'email';
  telegram_chat_id: string | null;
  telegram_bot_token_encrypted: Uint8Array | null;
  email_address: string | null;
}

/**
 * Pick the configured channel for a project. Defaults to ManualChannel when
 * no row is configured.
 */
export async function pickChannel(
  svc: SupabaseClient,
  projectId: string,
): Promise<ApprovalChannel> {
  const { data: row } = await svc
    .from('project_approval_channels')
    .select('channel, telegram_chat_id, telegram_bot_token_encrypted, email_address')
    .eq('project_id', projectId)
    .maybeSingle<ChannelRow>();

  if (!row || row.channel === 'manual') return new ManualChannel();

  if (row.channel === 'telegram') {
    if (!row.telegram_chat_id) {
      // Coherence ensured by the SQL check, but be defensive.
      console.warn('[approvals] channel-fallback', {
        project_id: projectId,
        configured: 'telegram',
        fallback: 'manual',
        reason: 'telegram_chat_id missing on project_approval_channels row',
      });
      return new ManualChannel();
    }
    const botToken = row.telegram_bot_token_encrypted
      ? new TextDecoder().decode(row.telegram_bot_token_encrypted)
      : (process.env.TELEGRAM_BOT_TOKEN ?? '');
    if (!botToken) {
      // W3 — emit a structured warning so operators can spot config drift.
      console.warn('[approvals] channel-fallback', {
        project_id: projectId,
        configured: 'telegram',
        fallback: 'manual',
        reason: 'TELEGRAM_BOT_TOKEN env var missing and no per-row token',
      });
      return new ManualChannel();
    }
    return new TelegramChannel({ chatId: row.telegram_chat_id, botToken });
  }

  if (row.channel === 'email') {
    if (!row.email_address) {
      console.warn('[approvals] channel-fallback', {
        project_id: projectId,
        configured: 'email',
        fallback: 'manual',
        reason: 'email_address missing on project_approval_channels row',
      });
      return new ManualChannel();
    }
    // Email sending uses the Resend REST API. The api key is sourced from
    // RESEND_API_KEY (preferred) or SMTP_PASS (when an SMTP-style env is
    // already configured for Resend — `re_*` key as the SMTP "password").
    const apiKey = process.env.RESEND_API_KEY ?? process.env.SMTP_PASS ?? '';
    const from = process.env.EMAIL_FROM_ADDRESS ?? process.env.SMTP_FROM ?? '';
    const signingSecret = process.env.EMAIL_SIGNING_SECRET ?? '';
    const baseUrl = process.env.APPROVAL_LINK_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '';
    if (!apiKey || !from || !signingSecret || !baseUrl) {
      const missing = [
        !apiKey && 'RESEND_API_KEY|SMTP_PASS',
        !from && 'EMAIL_FROM_ADDRESS|SMTP_FROM',
        !signingSecret && 'EMAIL_SIGNING_SECRET',
        !baseUrl && 'APPROVAL_LINK_BASE_URL|NEXT_PUBLIC_APP_URL',
      ].filter(Boolean);
      console.warn('[approvals] channel-fallback', {
        project_id: projectId,
        configured: 'email',
        fallback: 'manual',
        reason: `missing env vars: ${missing.join(', ')}`,
      });
      return new ManualChannel();
    }
    return new EmailChannel({
      apiKey,
      from,
      baseUrl,
      signingSecret,
      recipient: row.email_address,
    });
  }

  return new ManualChannel();
}
