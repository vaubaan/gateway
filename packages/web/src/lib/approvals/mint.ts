/**
 * Shared approval-lifecycle helpers used by both the user `/api/v1/tokens`
 * route and the programmatic `/api/v1/mgmt/tokens` route.
 *
 * Spec : docs/spec/gateway-capability-model.draft.md §8.
 */

import { type Capability, generateApiKey, hashApiKey } from '@vaubaan/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PendingMintInput {
  projectId: string;
  capabilities: Capability[];
  tokenName: string;
  ttlHours: number;
  channel: 'manual' | 'telegram';
  channelRef: string | null;
  context?: Record<string, unknown>;
  requestedByManagementKeyId?: string | null;
  requestedByUserId?: string | null;
}

export interface ApprovedMintResult {
  accessTokenId: string;
  apiKey: string;
  apiKeyPrefix: string;
  expiresAt: string;
}

/**
 * Mint an access token *now* for a previously-approved request, then mark
 * the approval as consumed in the same transaction-ish flow.
 *
 * Returns the api_key (plaintext, visible ONCE).
 */
export async function mintForApproval(
  svc: SupabaseClient,
  approvalId: string,
  ttlHours: number,
  tokenName: string,
  projectId: string,
  capabilities: Capability[],
): Promise<ApprovedMintResult> {
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  const { apiKey, apiKeyPrefix } = generateApiKey('live');
  const apiKeyHash = await hashApiKey(apiKey);

  const { data: inserted, error: insertErr } = await svc
    .from('access_tokens')
    .insert({
      project_id: projectId,
      name: tokenName,
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      status: 'active',
      expires_at: expiresAt,
      capabilities,
    })
    .select('id')
    .single<{ id: string }>();
  if (insertErr || !inserted) {
    throw new Error(insertErr?.message ?? 'failed to insert access token');
  }

  // Stash the api_key on the approval row for the caller's first poll, then
  // clear it. RLS is service-role-only on approval_requests.
  await svc
    .from('approval_requests')
    .update({
      access_token_id: inserted.id,
      pending_api_key: apiKey,
    })
    .eq('id', approvalId);

  return { accessTokenId: inserted.id, apiKey, apiKeyPrefix, expiresAt };
}
