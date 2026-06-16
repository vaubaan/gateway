/**
 * Bearer-auth guard for /api/v1/tokens/* (mint, preview, pending) routes.
 *
 * Verifies an `Authorization: Bearer vbn_live_…` header against the unified
 * `tokens` table (argon2id) and returns the parent token row that the caller
 * will use to mint a child. Touches `last_used_at` best-effort.
 *
 * Replaces the legacy `requireManagementKey` — every Bearer is `vbn_live_*`
 * now (cf. ADR unified-tokens-delegation-chain-and-escalation-channel.md §D3).
 *
 * Spec : docs/spec/vaubaan-gateway.md §3.1, §8.
 */

import { NextResponse } from 'next/server';
import {
  parseApiKey,
  verifyApiKey,
  type DelegationChainEntry,
  type RiskId,
  type Token,
} from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';

export type GuardedToken = Pick<
  Token,
  | 'id'
  | 'name'
  | 'organization_id'
  | 'parent_id'
  | 'scope'
  | 'project_id'
  | 'accepted_risks'
  | 'denied_risks'
  | 'depth'
  | 'delegation_chain'
  | 'status'
  | 'expires_at'
  | 'created_at'
  | 'created_by'
>;

export interface TokenGuardOk {
  ok: true;
  token: GuardedToken;
  orgId: string;
}

export interface TokenGuardErr {
  ok: false;
  response: NextResponse;
}

export type TokenGuard = TokenGuardOk | TokenGuardErr;

interface TokenAuthRow {
  id: string;
  name: string;
  organization_id: string;
  parent_id: string | null;
  scope: 'org' | 'project';
  project_id: string | null;
  accepted_risks: unknown;
  denied_risks: unknown;
  depth: number;
  delegation_chain: unknown;
  status: 'active' | 'revoked';
  api_key_hash: string;
  expires_at: string | null;
  created_at: string;
  created_by: string | null;
}

function unauthorized(message: string): TokenGuardErr {
  return {
    ok: false,
    response: NextResponse.json({ error: message }, { status: 401 }),
  };
}

function toRiskArray(v: unknown): RiskId[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is RiskId => typeof x === 'string');
}

function toDelegationChain(v: unknown): DelegationChainEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is DelegationChainEntry =>
      typeof x === 'object' && x !== null && typeof (x as DelegationChainEntry).id === 'string',
  );
}

export async function requireToken(authHeader: string | null): Promise<TokenGuard> {
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return unauthorized(
      'missing or malformed Authorization header (expected `Bearer vbn_live_…`).',
    );
  }
  const raw = authHeader.slice('bearer '.length).trim();
  const parsed = parseApiKey(raw);
  if (!parsed) return unauthorized('api_key format invalid.');
  if (parsed.kind !== 'live') {
    return unauthorized('this endpoint requires a vbn_live_* token.');
  }

  const svc = getSupabaseServiceClient();
  const { data: row } = await svc
    .from('tokens')
    .select(
      'id, name, organization_id, parent_id, scope, project_id, accepted_risks, denied_risks, depth, delegation_chain, status, api_key_hash, expires_at, created_at, created_by',
    )
    .eq('api_key_prefix', parsed.prefix)
    .maybeSingle<TokenAuthRow>();
  if (!row) return unauthorized('unknown api_key.');
  if (row.status !== 'active') return unauthorized('token is revoked.');
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    return unauthorized('token has expired.');
  }
  if (!(await verifyApiKey(row.api_key_hash, raw))) return unauthorized('api_key mismatch.');

  Promise.resolve(
    svc.from('tokens').update({ last_used_at: new Date().toISOString() }).eq('id', row.id),
  ).catch((e: unknown) => {
    console.error('[require-token] touch last_used_at failed', e);
  });

  return {
    ok: true,
    orgId: row.organization_id,
    token: {
      id: row.id,
      name: row.name,
      organization_id: row.organization_id,
      parent_id: row.parent_id,
      scope: row.scope,
      project_id: row.project_id,
      accepted_risks: toRiskArray(row.accepted_risks),
      denied_risks: toRiskArray(row.denied_risks),
      depth: row.depth,
      delegation_chain: toDelegationChain(row.delegation_chain),
      status: row.status,
      expires_at: row.expires_at,
      created_at: row.created_at,
      created_by: row.created_by,
    },
  };
}
