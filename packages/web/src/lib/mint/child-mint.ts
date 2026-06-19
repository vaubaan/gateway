/**
 * Token-mint helpers (post drop-confirm, post unified-tokens amendment 2026-06-19).
 *
 * Spec : docs/decisions/unified-tokens-delegation-chain-and-escalation-channel.md
 *        (amended 2026-06-19 — project-scoped roots only, no carte-blanche).
 * ADR  : docs/decisions/unified-gates-drop-confirm.md.
 *
 * Mints a child token from a known parent token, enforcing the subset /
 * depth / expires_at invariants. Every token is project-scoped — both
 * roots (parent_id = NULL, minted from the UI Project page with explicit
 * accepted_risks[]) and children (parent_id = caller.id). No bypass of
 * the subset check.
 */

import {
  generateApiKey,
  hashApiKey,
  type DelegationChainEntry,
  type RiskId,
  type Token,
} from '@vaubaan/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The subset of the parent token row we need for mint-time invariants. */
export type MintParent = Pick<
  Token,
  | 'id'
  | 'name'
  | 'organization_id'
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
  /** Project the child token is scoped to. Must match parent.project_id. */
  projectId: string;
  /** TTL in milliseconds. Null = never expire. */
  ttlMs: number | null;
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
  expiresAt: string | null;
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

/** Build the child's delegation_chain from the parent. */
export function computeChildChain(parent: MintParent): DelegationChainEntry[] {
  return [
    ...parent.delegation_chain,
    {
      id: parent.id,
      name: parent.name,
      depth: parent.depth,
      scope: 'project',
      created_at: parent.created_at,
      created_by: parent.created_by,
    },
  ];
}

/**
 * Verify the mint invariants against the parent and throw
 * `MintInvariantError` (caller maps to 403) on violation.
 *
 * Invariants (unified-tokens ADR D1, amended 2026-06-19) :
 *  - child.depth = parent.depth + 1 ≤ 5
 *  - child.expires_at ≤ parent.expires_at (when parent has expiry)
 *  - child.accepted_risks ⊆ parent.accepted_risks (always — no bypass)
 *  - child.denied_risks ⊇ parent.denied_risks (denials propagate)
 *  - child.project_id = parent.project_id (project-scoped roots only).
 */
export function checkMintInvariants(input: ChildMintInput, childExpiresAt: string | null): void {
  const { parent } = input;

  const childDepth = parent.depth + 1;
  if (childDepth > MAX_DEPTH) {
    throw new MintInvariantError(
      `max-depth: cannot mint a child at depth ${childDepth} (cap=${MAX_DEPTH}).`,
    );
  }

  if (parent.expires_at) {
    if (!childExpiresAt) {
      throw new MintInvariantError(
        `child token must not outlive parent (parent expires ${parent.expires_at}).`,
      );
    }
    if (Date.parse(childExpiresAt) > Date.parse(parent.expires_at)) {
      throw new MintInvariantError(
        `child token expires_at (${childExpiresAt}) exceeds parent's (${parent.expires_at}).`,
      );
    }
  }

  if (input.projectId !== parent.project_id) {
    throw new MintInvariantError(
      `child project_id (${input.projectId}) must match parent's (${parent.project_id}).`,
    );
  }

  const parentRisks = new Set(parent.accepted_risks);
  const missing = input.accepted_risks.filter((r) => !parentRisks.has(r));
  if (missing.length > 0) {
    throw new MintInvariantError(
      `subset-violation: child requests risks not held by parent: ${missing.join(', ')}`,
    );
  }

  const childDenied = new Set(input.denied_risks ?? []);
  const missingDenials = parent.denied_risks.filter((r) => !childDenied.has(r));
  if (missingDenials.length > 0) {
    throw new MintInvariantError(
      `denial-propagation: child must inherit parent denied_risks: ${missingDenials.join(', ')}`,
    );
  }
}

export interface RootMintInput {
  /** Org the root token belongs to. The mint endpoint must have verified
   *  org membership via session before calling this. */
  organizationId: string;
  /** Project the root token is scoped to. */
  projectId: string;
  /** Display name for the root token. Must be kebab-case + unique per org. */
  tokenName: string;
  /** TTL in milliseconds. Null = never expire. */
  ttlMs: number | null;
  /** Explicitly enumerated risks the root token accepts. No subset check
   *  (no parent) — but the caller is responsible for verifying the risks
   *  exist in the catalog and are acceptable for the project's bindings. */
  accepted_risks: readonly RiskId[];
  denied_risks?: readonly RiskId[];
  singleUse?: boolean;
  context?: Record<string, unknown> | null;
  /** Supabase auth.users.id of the human who clicked "Mint" in the dashboard. */
  createdBy: string;
}

/**
 * Mint a root token (parent_id = NULL, depth = 0). Called from the
 * dashboard session-fallback path — every root is project-scoped and
 * carries its `accepted_risks` explicitly enumerated.
 *
 * Throws generic `Error` (→ 500) on DB failure.
 */
export async function mintRootToken(
  svc: SupabaseClient,
  input: RootMintInput,
): Promise<ChildMintResult> {
  const expiresAt = input.ttlMs !== null ? new Date(Date.now() + input.ttlMs).toISOString() : null;
  const { apiKey, apiKeyPrefix } = generateApiKey('live');
  const apiKeyHash = await hashApiKey(apiKey);

  const { data: inserted, error: insertErr } = await svc
    .from('tokens')
    .insert({
      organization_id: input.organizationId,
      parent_id: null,
      scope: 'project',
      project_id: input.projectId,
      name: input.tokenName,
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      status: 'active',
      accepted_risks: input.accepted_risks,
      denied_risks: input.denied_risks ?? [],
      depth: 0,
      delegation_chain: [],
      context: input.context ?? null,
      expires_at: expiresAt,
      single_use: input.singleUse ?? false,
      created_by: input.createdBy,
    })
    .select('id')
    .single<{ id: string }>();
  if (insertErr || !inserted) {
    throw new Error(insertErr?.message ?? 'failed to insert root token');
  }

  return { tokenId: inserted.id, apiKey, apiKeyPrefix, expiresAt, delegationChain: [] };
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
  const expiresAt = input.ttlMs !== null ? new Date(Date.now() + input.ttlMs).toISOString() : null;
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
      scope: 'project',
      project_id: input.projectId,
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
