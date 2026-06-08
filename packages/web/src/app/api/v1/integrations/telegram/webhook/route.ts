/**
 * Telegram Bot webhook — receives `callback_query` updates from the ✅/❌
 * buttons the gateway sent for an approval request.
 *
 * Setup (one-time per env)
 *   1. Create a bot via @BotFather, set TELEGRAM_BOT_TOKEN.
 *   2. (Recommended) Generate a random secret and set TELEGRAM_WEBHOOK_SECRET.
 *   3. Tell Telegram about the webhook :
 *        POST https://api.telegram.org/bot<token>/setWebhook
 *          { url: 'https://<host>/api/v1/integrations/telegram/webhook',
 *            secret_token: '<TELEGRAM_WEBHOOK_SECRET>' }
 *      Telegram will include `X-Telegram-Bot-Api-Secret-Token` on every call ;
 *      we reject any update that doesn't match.
 *
 * The webhook is shared across all projects ; the per-project routing happens
 * via the `callback_data` payload `vbn:<approvalId>:<approve|deny>`.
 *
 * Spec : docs/spec/gateway-capability-model.draft.md §8.
 */

import { type NextRequest, NextResponse } from 'next/server';
import type { Capability } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { decideApproval } from '@/lib/approvals/decide';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CallbackQuery {
  id: string;
  data?: string;
  from?: { id?: number; username?: string; first_name?: string };
  message?: { chat?: { id?: number }; message_id?: number };
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: CallbackQuery;
}

interface ApprovalRow {
  id: string;
  project_id: string;
  status: string;
  requested_capabilities: Capability[];
  requested_token_name: string;
  requested_ttl_hours: number;
  channel: string;
  channel_ref: string | null;
}

const TELEGRAM_API = 'https://api.telegram.org';

export async function POST(req: NextRequest) {
  // Verify the secret token if configured.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const got = req.headers.get('x-telegram-bot-api-secret-token');
    if (got !== expectedSecret) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const cb = update.callback_query;
  if (!cb || !cb.data) return NextResponse.json({ ok: true }, { status: 200 });

  // Expect `vbn:<approvalId>:<approve|deny>`. Ignore everything else (the bot
  // might be in chats that use it for other things).
  const m = /^vbn:([0-9a-f-]{36}):(approve|deny)$/i.exec(cb.data);
  if (!m) return NextResponse.json({ ok: true }, { status: 200 });
  const approvalId = m[1]!;
  const decision = m[2] as 'approve' | 'deny';

  const svc = getSupabaseServiceClient();
  const { data: row } = await svc
    .from('approval_requests')
    .select(
      'id, project_id, status, requested_capabilities, requested_token_name, requested_ttl_hours, channel, channel_ref',
    )
    .eq('id', approvalId)
    .maybeSingle<ApprovalRow>();
  if (!row || row.channel !== 'telegram') {
    await answerCallback(cb.id, 'approval not found or not a telegram-bound one');
    return NextResponse.json({ ok: true }, { status: 200 });
  }
  if (row.status !== 'pending') {
    await answerCallback(cb.id, `already ${row.status}`);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const decidedBy = cb.from?.username
    ? `tg:@${cb.from.username}`
    : cb.from?.first_name
      ? `tg:${cb.from.first_name}`
      : `tg:id=${cb.from?.id ?? 'unknown'}`;

  await decideApproval(svc, {
    approvalId,
    decision,
    decidedBy,
    projectId: row.project_id,
    capabilities: row.requested_capabilities,
    tokenName: row.requested_token_name,
    ttlHours: row.requested_ttl_hours,
  });

  await answerCallback(cb.id, decision === 'approve' ? '✅ approved' : '❌ denied');
  // Best-effort : edit the original message to remove the buttons and record the decision.
  if (cb.message?.chat?.id && cb.message?.message_id) {
    await editMessage(cb.message.chat.id, cb.message.message_id, decision, decidedBy);
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}

async function answerCallback(callbackQueryId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (e) {
    console.error('[telegram] answerCallbackQuery failed', e);
  }
}

async function editMessage(
  chatId: number,
  messageId: number,
  decision: 'approve' | 'deny',
  decidedBy: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const icon = decision === 'approve' ? '✅' : '❌';
  const text = `${icon} Vaubaan approval ${decision === 'approve' ? 'approved' : 'denied'} by ${decidedBy}`;
  try {
    await fetch(`${TELEGRAM_API}/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: { inline_keyboard: [] },
      }),
    });
  } catch (e) {
    console.error('[telegram] editMessageText failed', e);
  }
}
