/**
 * Resolve an approval — shared by the operator API and the Telegram webhook.
 *
 *   approve → mints access_token now, stashes api_key on the approval row,
 *             status='approved' (next poll consumes it).
 *   deny    → status='denied' (next poll returns 410).
 *
 * Idempotent guard : the caller must have verified that the row is still
 * 'pending' before calling. We re-check inside via the WHERE clause so a race
 * just no-ops cleanly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Capability } from '@vaubaan/shared';
import { mintForApproval } from './mint';

export interface DecideInput {
  approvalId: string;
  decision: 'approve' | 'deny';
  decidedBy: string;
  projectId: string;
  capabilities: Capability[];
  tokenName: string;
  ttlHours: number;
}

export interface DecideResult {
  status: 'approved' | 'denied';
  accessTokenId?: string;
}

export async function decideApproval(
  svc: SupabaseClient,
  input: DecideInput,
): Promise<DecideResult> {
  const now = new Date().toISOString();

  if (input.decision === 'deny') {
    await svc
      .from('approval_requests')
      .update({ status: 'denied', decided_by: input.decidedBy, decided_at: now })
      .eq('id', input.approvalId)
      .eq('status', 'pending');
    return { status: 'denied' };
  }

  // approve : mint first, then mark approved on the same row.
  const minted = await mintForApproval(
    svc,
    input.approvalId,
    input.ttlHours,
    input.tokenName,
    input.projectId,
    input.capabilities,
  );
  await svc
    .from('approval_requests')
    .update({ status: 'approved', decided_by: input.decidedBy, decided_at: now })
    .eq('id', input.approvalId)
    .eq('status', 'pending');

  return { status: 'approved', accessTokenId: minted.accessTokenId };
}
