/**
 * Helper : resolve the parent token row for an approval-driven mint.
 *
 * When an approval row was created by a vbn_live_* caller, we stash a hint
 * on the approval (currently — for v0 — we use the decider as parent).
 *
 * v0 simplification : the decider is the parent. This means an org operator
 * who decides on behalf of a story-dev creates the child token under their
 * own authority. This is acceptable for MVP because the org operator is the
 * authority figure for the org. We will refine this in a later iteration
 * (track the original requester's token id on the approval row).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MintParent } from './mint';
import type { GuardedToken } from '@/lib/auth/require-token';

export async function loadParentTokenForApproval(
  _svc: SupabaseClient,
  _approvalId: string,
  fallback: GuardedToken,
): Promise<MintParent> {
  // v0 : we don't yet snapshot the requester on the approval row.
  // Use the deciding token as the parent.
  return {
    id: fallback.id,
    name: fallback.name,
    organization_id: fallback.organization_id,
    scope: fallback.scope,
    project_id: fallback.project_id,
    accepted_risks: fallback.accepted_risks,
    denied_risks: fallback.denied_risks,
    depth: fallback.depth,
    delegation_chain: fallback.delegation_chain,
    expires_at: fallback.expires_at,
    created_at: fallback.created_at,
    created_by: fallback.created_by,
  };
}
