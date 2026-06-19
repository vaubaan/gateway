/**
 * Auth guard for /api/v1/tokens/* (mint, preview) routes.
 *
 * Two modes :
 *  1. **Bearer (child-mint mode)** — verifies `Authorization: Bearer vbn_live_…`
 *     against the unified `tokens` table (argon2id) and returns the parent
 *     token row that the caller will use to mint a child. The mint endpoint
 *     enforces `child.accepted_risks ⊆ parent.accepted_risks` invariant.
 *     Touches `last_used_at` best-effort.
 *  2. **Session fallback (root-mint mode)** — when no valid Bearer is present
 *     AND the caller opted in via `{ allowSessionFallback: { orgId | orgSlug } }`,
 *     resolve the Supabase session, verify org membership, and return a
 *     `'session'` mode marker. The mint endpoint then creates a root token
 *     (`parent_id = NULL`, `depth = 0`) with the explicitly enumerated
 *     `accepted_risks` from the body — no subset check (no parent).
 *
 * Spec : docs/spec/vaubaan-gateway.md §3.1, §8.8.
 * ADR  : docs/decisions/unified-tokens-delegation-chain-and-escalation-channel.md
 *        (amended 2026-06-19 — project-scoped roots, no carte-blanche).
 */

import { NextResponse } from 'next/server';
import {
  parseApiKey,
  verifyApiKey,
  type DelegationChainEntry,
  type RiskId,
  type Token,
} from '@vaubaan/shared';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';

export type GuardedToken = Pick<
  Token,
  | 'id'
  | 'name'
  | 'organization_id'
  | 'parent_id'
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

export interface TokenGuardBearer {
  ok: true;
  mode: 'bearer';
  /** The parent token. The mint endpoint will mint a child of this token. */
  token: GuardedToken;
  orgId: string;
}

export interface TokenGuardSession {
  ok: true;
  mode: 'session';
  /** The org the session user is a member of. The mint endpoint will mint
   *  a project-scoped root token (`parent_id = NULL`) in this org. */
  orgId: string;
  userId: string;
}

export interface TokenGuardErr {
  ok: false;
  response: NextResponse;
}

export type TokenGuard = TokenGuardBearer | TokenGuardSession | TokenGuardErr;

interface TokenAuthRow {
  id: string;
  name: string;
  organization_id: string;
  parent_id: string | null;
  project_id: string;
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

/**
 * Opt-in session fallback. When set, `requireToken` will attempt to resolve
 * the request via Supabase cookie session if no valid Bearer is present.
 *
 *  - `orgId` or `orgSlug` : the org the session user must be a member of.
 *    The mint endpoint will then create a project-scoped root token in
 *    this org.
 */
export interface SessionFallbackHint {
  orgId?: string;
  orgSlug?: string;
}

export interface RequireTokenOptions {
  /** When provided, enable the cookie-auth fallback. Returns `mode: 'session'`
   *  so the mint endpoint switches to root-mint behavior. */
  allowSessionFallback?: SessionFallbackHint;
}

export async function requireToken(
  authHeader: string | null,
  options?: RequireTokenOptions,
): Promise<TokenGuard> {
  // ── Bearer path ─────────────────────────────────────────────────────────
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const raw = authHeader.slice('bearer '.length).trim();
    const parsed = parseApiKey(raw);
    if (parsed && parsed.kind === 'live') {
      const svc = getSupabaseServiceClient();
      const { data: row } = await svc
        .from('tokens')
        .select(
          'id, name, organization_id, parent_id, project_id, accepted_risks, denied_risks, depth, delegation_chain, status, api_key_hash, expires_at, created_at, created_by',
        )
        .eq('api_key_prefix', parsed.prefix)
        .maybeSingle<TokenAuthRow>();
      if (!row) return unauthorized('unknown api_key.');
      if (row.status !== 'active') return unauthorized('token is revoked.');
      if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
        return unauthorized('token has expired.');
      }
      if (!(await verifyApiKey(row.api_key_hash, raw))) return unauthorized('api_key mismatch.');

      // Fire-and-forget : the `last_used_at` touch is best-effort
      // (logging probe). We don't `await` so the auth hot path stays
      // synchronous ; `void` + `.then().catch()` makes the lint-clean
      // intent explicit (no floating promise warning).
      void svc
        .from('tokens')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', row.id)
        .then(({ error }) => {
          if (error) console.error('[require-token] touch last_used_at failed', error);
        });

      return {
        ok: true,
        mode: 'bearer',
        orgId: row.organization_id,
        token: {
          id: row.id,
          name: row.name,
          organization_id: row.organization_id,
          parent_id: row.parent_id,
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
    // Bearer present but malformed/wrong kind → fall through to session fallback
    // if enabled, else 401.
    if (!options?.allowSessionFallback) {
      if (!parsed) return unauthorized('api_key format invalid.');
      return unauthorized('this endpoint requires a vbn_live_* token.');
    }
  }

  // ── Session fallback ────────────────────────────────────────────────────
  if (!options?.allowSessionFallback) {
    return unauthorized(
      'missing or malformed Authorization header (expected `Bearer vbn_live_…`).',
    );
  }
  return resolveSessionFallback(options.allowSessionFallback);
}

/**
 * Resolve the dashboard session into a `mode: 'session'` guard. The mint
 * endpoint will then mint a project-scoped root token (parent_id=NULL)
 * with the explicitly enumerated risks from the request body — no parent,
 * no subset check.
 */
async function resolveSessionFallback(hint: SessionFallbackHint): Promise<TokenGuard> {
  const ssr = await getSupabaseServer();
  const { data: userRes } = await ssr.auth.getUser();
  if (!userRes.user) return unauthorized('session expired — sign in again.');

  const svc = getSupabaseServiceClient();

  let orgId: string | null = hint.orgId ?? null;
  if (!orgId && hint.orgSlug) {
    const { data: orgRow } = await svc
      .from('organizations')
      .select('id')
      .eq('slug', hint.orgSlug)
      .maybeSingle<{ id: string }>();
    orgId = orgRow?.id ?? null;
  }
  if (!orgId) return unauthorized('session fallback: missing org context.');

  const { data: member } = await svc
    .from('org_members')
    .select('user_id')
    .eq('organization_id', orgId)
    .eq('user_id', userRes.user.id)
    .maybeSingle<{ user_id: string }>();
  if (!member) return unauthorized('session fallback: user is not a member of this org.');

  return {
    ok: true,
    mode: 'session',
    orgId,
    userId: userRes.user.id,
  };
}
