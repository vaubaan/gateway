/**
 * ManualChannel — no-op channel. The approval row is created with status
 * 'pending' ; the operator approves via the dashboard or
 * `POST /api/v1/mgmt/approvals/:id`. Useful for dev / CI / clients that don't
 * want a chat integration.
 */
import type { ApprovalChannel, ApprovalChannelDispatched, ApprovalRequestPayload } from './channel';

export class ManualChannel implements ApprovalChannel {
  readonly id = 'manual' as const;
  async open(_req: ApprovalRequestPayload): Promise<ApprovalChannelDispatched> {
    return { channelRef: null };
  }
}
