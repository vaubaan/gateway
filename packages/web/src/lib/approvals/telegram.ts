/**
 * TelegramChannel — sends a Bot API `sendMessage` carrying an inline keyboard
 * with two callback buttons (✅ Approve, ❌ Deny). The webhook handler at
 * `/api/v1/integrations/telegram/webhook` parses the callback_query and
 * resolves the approval_requests row.
 *
 * Bot setup
 *   1. Create a bot via @BotFather, copy the token to TELEGRAM_BOT_TOKEN
 *      (or persist per-project in `project_approval_channels.telegram_bot_token_encrypted`).
 *   2. Add the bot to the chat (group, channel, or DM) you want to receive
 *      approvals in ; copy that chat's id to
 *      `project_approval_channels.telegram_chat_id`.
 *   3. Set the webhook : `POST https://api.telegram.org/bot<token>/setWebhook`
 *      with `{ url: 'https://<host>/api/v1/integrations/telegram/webhook' }`.
 *
 * Callback data shape : the inline button's `callback_data` is
 * `vbn:<approvalId>:<approve|deny>`. The webhook handler routes from there.
 */

import { formatCapability } from '@vaubaan/shared';
import type { ApprovalChannel, ApprovalChannelDispatched, ApprovalRequestPayload } from './channel';

export interface TelegramChannelConfig {
  chatId: string;
  botToken: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  baseUrl?: string;
}

interface SendMessageResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

const DEFAULT_BASE = 'https://api.telegram.org';

export class TelegramChannel implements ApprovalChannel {
  readonly id = 'telegram' as const;
  private readonly chatId: string;
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(cfg: TelegramChannelConfig) {
    this.chatId = cfg.chatId;
    this.botToken = cfg.botToken;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.baseUrl = cfg.baseUrl ?? DEFAULT_BASE;
  }

  async open(req: ApprovalRequestPayload): Promise<ApprovalChannelDispatched> {
    const caps = req.capabilities.map((c) => `• \`${formatCapability(c)}\``).join('\n');
    const contextStr = req.context
      ? Object.entries(req.context)
          .map(([k, v]) => `*${escapeMd(k)}*: ${escapeMd(String(v))}`)
          .join('\n')
      : '_no context_';

    const text = [
      '*🔐 Vaubaan — approval requested*',
      '',
      `*Project*: ${escapeMd(req.projectName ?? req.projectId)}`,
      `*Token*: \`${escapeMd(req.tokenName)}\` _(ttl ${req.ttlHours}h)_`,
      '',
      '*Capabilities*:',
      caps,
      '',
      '*Context*:',
      contextStr,
    ].join('\n');

    const body = {
      chat_id: this.chatId,
      text,
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `vbn:${req.approvalId}:approve` },
            { text: '❌ Deny', callback_data: `vbn:${req.approvalId}:deny` },
          ],
        ],
      },
    };

    const res = await this.fetchImpl(`${this.baseUrl}/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as SendMessageResponse;
    if (!res.ok || !json.ok || !json.result) {
      throw new Error(
        `TelegramChannel: sendMessage failed (${res.status}): ${json.description ?? 'no description'}`,
      );
    }
    return { channelRef: String(json.result.message_id) };
  }
}

/** MarkdownV2 reserved characters per Telegram Bot API docs. */
function escapeMd(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
