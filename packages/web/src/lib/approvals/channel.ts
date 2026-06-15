/**
 * ApprovalChannel — the abstraction the mint endpoints use to ask a human
 * "may I grant these risks ?".
 *
 * Spec : docs/spec/gateway-risk-model.md §10.
 *
 * Implementations
 *   - `ManualChannel`     : no notification. Operator approves via the
 *                           dashboard or `POST /api/v1/mgmt/approvals/:id`.
 *   - `TelegramChannel`   : sends a message with inline ✅/❌ buttons to a
 *                           project-bound Telegram chat. The webhook handler
 *                           reads the callback_query and resolves the row.
 *   - `EmailChannel`      : sends an email with two signed approve/deny
 *                           links. The /approve route verifies the JWT-like
 *                           HMAC token and resolves the row.
 */

import type { RiskId } from '@vaubaan/shared';

export interface ApprovalRequestPayload {
  approvalId: string;
  projectId: string;
  projectName?: string;
  /** The full set of risks the token would grant — for context in the
   *  approver notification. */
  acceptedRisks: readonly RiskId[];
  /** Risks gated as `confirm` — the actual reason the approval was opened. */
  needsApproval: readonly RiskId[];
  tokenName: string;
  ttlHours: number;
  /** Free-form context the caller wants to surface to the approver. */
  context?: Record<string, unknown>;
}

export interface ApprovalChannelDispatched {
  /** Channel-native ref (e.g. Telegram message id, email recipient address)
   *  — stored on the approval_requests row so the channel can edit/update
   *  its UI when the decision lands. Null when the channel has no ref. */
  channelRef: string | null;
}

export interface ApprovalChannel {
  /** Channel identifier, persisted on approval_requests.channel. */
  readonly id: 'manual' | 'telegram' | 'email';

  /**
   * Dispatch the approval request. The row has already been inserted with
   * status='pending' ; this method only handles the side-effect (sending a
   * Telegram message, etc.). Throws if the dispatch fails so the caller can
   * roll back the row or fall back to manual.
   */
  open(req: ApprovalRequestPayload): Promise<ApprovalChannelDispatched>;
}
