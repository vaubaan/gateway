/**
 * ApprovalChannel — the abstraction the mint endpoints use to ask a human
 * "may I grant this capability ?".
 *
 * Spec : docs/spec/gateway-capability-model.md §8.
 *
 * Implementations
 *   - `ManualChannel`     : no notification. Operator approves via the
 *                           dashboard or `POST /api/v1/mgmt/approvals/:id`.
 *   - `TelegramChannel`   : sends a message with inline ✅/❌ buttons to a
 *                           project-bound Telegram chat. The webhook handler
 *                           reads the callback_query and resolves the row.
 *
 * New channels (Slack, e-mail, webhook) plug in by implementing this
 * interface and adding a branch in `pickChannel()`.
 */

import type { Capability } from '@vaubaan/shared';

export interface ApprovalRequestPayload {
  approvalId: string;
  projectId: string;
  projectName?: string;
  capabilities: Capability[];
  tokenName: string;
  ttlHours: number;
  /** Free-form context the caller wants to surface to the approver. */
  context?: Record<string, unknown>;
}

export interface ApprovalChannelDispatched {
  /** Channel-native ref (e.g. Telegram message id) — stored on the
   *  approval_requests row so the channel can edit/update its UI when the
   *  decision lands. Null when the channel has no ref. */
  channelRef: string | null;
}

export interface ApprovalChannel {
  /** Channel identifier, persisted on approval_requests.channel. */
  readonly id: 'manual' | 'telegram';

  /**
   * Dispatch the approval request. The row has already been inserted with
   * status='pending' ; this method only handles the side-effect (sending a
   * Telegram message, etc.). Throws if the dispatch fails so the caller can
   * roll back the row or fall back to manual.
   */
  open(req: ApprovalRequestPayload): Promise<ApprovalChannelDispatched>;
}
