/**
 * V4 risk-based mint helper — used by the `/api/v1/mgmt/tokens` POST and
 * the future approve decision path. Mirrors `mint.ts` (v1, capability-based)
 * but writes `accepted_risks` / `denied_risks` columns on `access_tokens`
 * instead of `capabilities`.
 *
 * Spec : docs/spec/gateway-risk-model.md §5 (wire), §9 (mint flow).
 */

import { generateApiKey, hashApiKey, type RiskId } from '@vaubaan/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RiskMintInput {
  projectId: string;
  tokenName: string;
  /** TTL in milliseconds. */
  ttlMs: number;
  accepted_risks: readonly RiskId[];
  denied_risks?: readonly RiskId[];
  singleUse?: boolean;
}

export interface RiskMintResult {
  accessTokenId: string;
  apiKey: string;
  apiKeyPrefix: string;
  expiresAt: string;
}

/**
 * Mint a v4 access_token NOW (no approval flow), returning the plaintext
 * api_key once. The caller is responsible for ensuring the request is
 * authorized (all effective gates are `allow`).
 */
export async function mintRiskAccessToken(
  svc: SupabaseClient,
  input: RiskMintInput,
): Promise<RiskMintResult> {
  const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
  const { apiKey, apiKeyPrefix } = generateApiKey('live');
  const apiKeyHash = await hashApiKey(apiKey);

  const { data: inserted, error: insertErr } = await svc
    .from('access_tokens')
    .insert({
      project_id: input.projectId,
      name: input.tokenName,
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      status: 'active',
      expires_at: expiresAt,
      // v4 columns (migration 0025).
      accepted_risks: input.accepted_risks,
      denied_risks: input.denied_risks ?? [],
      // Legacy v1 columns kept around for the dual-mode boot — see
      // migration 0031 cleanup note. We write an empty array so the NOT
      // NULL constraint is satisfied without claiming any v1 capability.
      capabilities: [],
      single_use: input.singleUse ?? false,
    })
    .select('id')
    .single<{ id: string }>();
  if (insertErr || !inserted) {
    throw new Error(insertErr?.message ?? 'failed to insert access token');
  }

  return { accessTokenId: inserted.id, apiKey, apiKeyPrefix, expiresAt };
}

/**
 * Mint a v4 token for a previously-approved request, then stash the
 * plaintext api_key on the approval row so the caller's next poll picks
 * it up. Mirrors `mintForApproval` (v1).
 */
export async function mintForApprovalV4(
  svc: SupabaseClient,
  approvalId: string,
  input: RiskMintInput,
): Promise<RiskMintResult> {
  const minted = await mintRiskAccessToken(svc, input);
  await svc
    .from('approval_requests')
    .update({
      access_token_id: minted.accessTokenId,
      pending_api_key: minted.apiKey,
    })
    .eq('id', approvalId);
  return minted;
}

// ─────────────────────────────────────────────────────────────────────────────
// V4 approval decision (mirror of decideApproval in decide.ts but reading
// `requested_risks` / `denied_risks` and minting via mintForApprovalV4).
// Used by both the operator decide endpoint and the email decide route.
// ─────────────────────────────────────────────────────────────────────────────

export interface DecideApprovalV4Input {
  approvalId: string;
  decision: 'approve' | 'deny';
  decidedBy: string;
  projectId: string;
  acceptedRisks: readonly RiskId[];
  deniedRisks: readonly RiskId[];
  tokenName: string;
  ttlHours: number;
  singleUse?: boolean;
}

export interface DecideApprovalV4Result {
  status: 'approved' | 'denied';
  accessTokenId?: string;
}

export async function decideApprovalV4(
  svc: SupabaseClient,
  input: DecideApprovalV4Input,
): Promise<DecideApprovalV4Result> {
  const now = new Date().toISOString();

  if (input.decision === 'deny') {
    await svc
      .from('approval_requests')
      .update({ status: 'denied', decided_by: input.decidedBy, decided_at: now })
      .eq('id', input.approvalId)
      .eq('status', 'pending');
    return { status: 'denied' };
  }

  const minted = await mintForApprovalV4(svc, input.approvalId, {
    projectId: input.projectId,
    tokenName: input.tokenName,
    ttlMs: input.ttlHours * 3600_000,
    accepted_risks: input.acceptedRisks,
    denied_risks: input.deniedRisks,
    singleUse: input.singleUse,
  });

  await svc
    .from('approval_requests')
    .update({ status: 'approved', decided_by: input.decidedBy, decided_at: now })
    .eq('id', input.approvalId)
    .eq('status', 'pending');

  return { status: 'approved', accessTokenId: minted.accessTokenId };
}
