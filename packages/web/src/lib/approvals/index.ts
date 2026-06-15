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
      return new ManualChannel();
    }
    const botToken = row.telegram_bot_token_encrypted
      ? new TextDecoder().decode(row.telegram_bot_token_encrypted)
      : (process.env.TELEGRAM_BOT_TOKEN ?? '');
    if (!botToken) {
      // No bot token configured anywhere → silently fall back.
      console.warn(
        `[approvals] project ${projectId} configured for telegram but no bot token available — falling back to manual`,
      );
      return new ManualChannel();
    }
    return new TelegramChannel({ chatId: row.telegram_chat_id, botToken });
  }

  if (row.channel === 'email') {
    if (!row.email_address) return new ManualChannel();
    const apiKey = process.env.RESEND_API_KEY ?? '';
    const from = process.env.EMAIL_FROM_ADDRESS ?? '';
    const signingSecret = process.env.EMAIL_SIGNING_SECRET ?? '';
    const baseUrl = process.env.APPROVAL_LINK_BASE_URL ?? '';
    if (!apiKey || !from || !signingSecret || !baseUrl) {
      console.warn(
        `[approvals] project ${projectId} configured for email but env vars are incomplete — falling back to manual`,
      );
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
