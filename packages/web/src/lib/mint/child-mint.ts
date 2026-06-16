/**
 * Token-mint helpers (post drop-confirm).
 *
 * Spec : docs/decisions/unified-tokens-delegation-chain-and-escalation-channel.md.
 * ADR  : docs/decisions/unified-gates-drop-confirm.md.
 *
 * Mints a child token from a known parent token, enforcing the subset /
 * depth / expires_at invariants. Post drop-confirm the mint-time approval
 * loop is gone — every successful preview leads directly to an INSERT
 * into `tokens`. Escalation happens at runtime, outside the gateway, via
 * the parent's `context.escalation_channel`.
 */

import {
  generateApiKey,
  hashApiKey,
  type DelegationChainEntry,
  type RiskId,
  type Token,
  type TokenScope,
} from '@vaubaan/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The subset of the parent token row we need for mint-time invariants. */
export type MintParent = Pick<
  Token,
  | 'id'
  | 'name'
  | 'organization_id'
  | 'scope'
  | 'project_id'
  | 'accepted_risks'
  | 'denied_risks'
  | 'depth'
  | 'delegation_chain'
  | 'expires_at'
  | 'created_at'
  | 'created_by'
>;

export interface ChildMintInput {
  parent: MintParent;
  /** Display name for the child token. Must be kebab-case + unique per org. */
  tokenName: string;
  /** Effective scope on the child. */
  scope: TokenScope;
  /** Required when scope='project'. */
  projectId?: string | null;
  /** TTL in milliseconds. */
  ttlMs: number;
  accepted_risks: readonly RiskId[];
  denied_risks?: readonly RiskId[];
  singleUse?: boolean;
  /** Free-form context payload — at mint time this is the unparsed body
   *  from the HTTP caller. Stored verbatim ; readers narrow to {@link TokenContext}
   *  when they need `escalation_channel` etc. */
  context?: Record<string, unknown> | null;
  createdBy?: string | null;
}

export interface ChildMintResult {
  tokenId: string;
  apiKey: string;
  apiKeyPrefix: string;
  expiresAt: string;
  delegationChain: DelegationChainEntry[];
}

export class MintInvariantError extends Error {
  public readonly httpStatus = 403;
  constructor(message: string) {
    super(message);
    this.name = 'MintInvariantError';
  }
}

export const MAX_DEPTH = 5;

/**
 * Carte-blanche bypass rule (unified-tokens ADR §3 "data-migration shim").
 *
 * A root org-scoped token with NO accepted_risks is treated as having
 * implicit grant on every risk — the subset check is skipped at mint
 * time. This is the side-door that lets the migrated `org_management_keys`
 * rows continue to mint child tokens (they have `accepted_risks=[]` by
 * design — the legacy mgmt-key authorised by org membership, not by a
 * risk grant).
 */
export function isCarteBlancheParent(parent: MintParent): boolean {
  return parent.scope === 'org' && parent.depth === 0 && (parent.accepted_risks?.length ?? 0) === 0;
}

/** Build the child's delegation_chain from the parent. */
export function computeChildChain(parent: MintParent): DelegationChainEntry[] {
  return [
    ...parent.delegation_chain,
    {
      id: parent.id,
      name: parent.name,
      depth: parent.depth,
      scope: parent.scope,
      created_at: parent.created_at,
      created_by: parent.created_by,
    },
  ];
}

/**
 * Verify the mint invariants against the parent and throw
 * `MintInvariantError` (caller maps to 403) on violation.
 *
 * Invariants (unified-tokens ADR D1) :
 *  - child.depth = parent.depth + 1 ≤ 5
 *  - child.expires_at ≤ parent.expires_at (when parent has expiry)
 *  - child.accepted_risks ⊆ parent.accepted_risks
 *    EXCEPT when parent is a "carte blanche" root (scope='org' AND
 *    accepted_risks=[]) — legacy mgmt-key migrated row.
 *  - child.denied_risks ⊇ parent.denied_risks (denials propagate)
 *  - scope rules : org parent → org|project ; project parent → project (same project_id).
 */
export function checkMintInvariants(input: ChildMintInput, childExpiresAt: string): void {
  const { parent } = input;

  const childDepth = parent.depth + 1;
  if (childDepth > MAX_DEPTH) {
    throw new MintInvariantError(
      `max-depth: cannot mint a child at depth ${childDepth} (cap=${MAX_DEPTH}).`,
    );
  }

  if (parent.expires_at) {
    if (Date.parse(childExpiresAt) > Date.parse(parent.expires_at)) {
      throw new MintInvariantError(
        `child token expires_at (${childExpiresAt}) exceeds parent's (${parent.expires_at}).`,
      );
    }
  }

  if (parent.scope === 'project') {
    if (input.scope !== 'project') {
      throw new MintInvariantError(
        `parent token is project-scoped — child must also be project-scoped.`,
      );
    }
    if (input.projectId !== parent.project_id) {
      throw new MintInvariantError(
        `child project_id (${input.projectId}) must match parent's (${parent.project_id}).`,
      );
    }
  }
  if (input.scope === 'project' && !input.projectId) {
    throw new MintInvariantError(`scope='project' requires a project_id on the child.`);
  }
  if (input.scope === 'org' && input.projectId) {
    throw new MintInvariantError(`scope='org' must not carry a project_id.`);
  }

  if (!isCarteBlancheParent(parent)) {
    const parentRisks = new Set(parent.accepted_risks);
    const missing = input.accepted_risks.filter((r) => !parentRisks.has(r));
    if (missing.length > 0) {
      throw new MintInvariantError(
        `subset-violation: child requests risks not held by parent: ${missing.join(', ')}`,
      );
    }
  }

  const childDenied = new Set(input.denied_risks ?? []);
  const missingDenials = parent.denied_risks.filter((r) => !childDenied.has(r));
  if (missingDenials.length > 0) {
    throw new MintInvariantError(
      `denial-propagation: child must inherit parent denied_risks: ${missingDenials.join(', ')}`,
    );
  }
}

/**
 * Mint a child token now. Caller is responsible for ensuring the
 * `accepted_risks` are acceptable for their bindings (cf. preview).
 *
 * Throws `MintInvariantError` (→ 403) on subset/depth/expires_at violation,
 * or generic `Error` (→ 500) on DB failure.
 */
export async function mintChildToken(
  svc: SupabaseClient,
  input: ChildMintInput,
): Promise<ChildMintResult> {
  const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
  checkMintInvariants(input, expiresAt);

  const { apiKey, apiKeyPrefix } = generateApiKey('live');
  const apiKeyHash = await hashApiKey(apiKey);
  const delegationChain = computeChildChain(input.parent);
  const childDepth = input.parent.depth + 1;

  const { data: inserted, error: insertErr } = await svc
    .from('tokens')
    .insert({
      organization_id: input.parent.organization_id,
      parent_id: input.parent.id,
      scope: input.scope,
      project_id: input.scope === 'project' ? input.projectId : null,
      name: input.tokenName,
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      status: 'active',
      accepted_risks: input.accepted_risks,
      denied_risks: input.denied_risks ?? [],
      depth: childDepth,
      delegation_chain: delegationChain,
      context: input.context ?? null,
      expires_at: expiresAt,
      single_use: input.singleUse ?? false,
      created_by: input.createdBy ?? null,
    })
    .select('id')
    .single<{ id: string }>();
  if (insertErr || !inserted) {
    throw new Error(insertErr?.message ?? 'failed to insert child token');
  }

  return { tokenId: inserted.id, apiKey, apiKeyPrefix, expiresAt, delegationChain };
}
