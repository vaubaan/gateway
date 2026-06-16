/**
 * `externalApprovalParent` — synthesize a synthetic carte-blanche root
 * parent token for an externally-authorized approval decision (Telegram
 * webhook callback, Email click, UI org-member session click).
 *
 * The synthesized parent has `scope='org', depth=0, accepted_risks=[]`
 * which triggers the carte-blanche bypass in `mintChildToken` (cf. ADR
 * unified-tokens-delegation-chain-and-escalation-channel.md §"data
 * migration shim"). This is the side-door that lets external-channel
 * approvals mint a child without holding a parent Bearer at decide-time.
 *
 * Centralised so :
 *   1. Future cleanup of the shim has a single call-site to update.
 *   2. Audit forensics : `grep externalApprovalParent` returns every
 *      place where the subset-check is bypassed.
 *   3. The 'channel' label is propagated to the synthesized parent's
 *      `name` field so the audit row's delegation_chain remembers
 *      which channel authorized the bypass.
 *
 * Dette : remove once `approval_requests` carries the original
 * requester's token id (W3 in the clean-code report).
 */

import type { MintParent } from './mint';

export type ExternalChannel = 'email' | 'telegram' | 'user-session';

const CHANNEL_NAMES: Record<ExternalChannel, string> = {
  email: 'email-approval',
  telegram: 'telegram-approval',
  'user-session': 'user-session-approval',
};

export interface ExternalApprovalParentInput {
  /** The approval row id — kept as a placeholder for `id` so the
   *  delegation_chain has a stable reference (the row will be marked
   *  consumed after mint, so this id is harmless in audit). */
  approvalId: string;
  /** Org id resolved by the caller via project join or guard. */
  organizationId: string;
  /** Channel marker — surfaces in the synthesized parent's `name`. */
  channel: ExternalChannel;
  /** When the caller can attribute the decision to a known user
   *  (currently only the user-session route), pass the user id here.
   *  Otherwise null (Telegram callback, Email click). */
  createdBy: string | null;
}

export function externalApprovalParent(input: ExternalApprovalParentInput): MintParent {
  return {
    id: input.approvalId,
    name: CHANNEL_NAMES[input.channel],
    organization_id: input.organizationId,
    scope: 'org',
    project_id: null,
    accepted_risks: [],
    denied_risks: [],
    depth: 0,
    delegation_chain: [],
    expires_at: null,
    created_at: new Date().toISOString(),
    created_by: input.createdBy,
  };
}
