/**
 * Auth guard for /api/v1/tokens/* (mint, preview) routes.
 *
 * Two paths :
 *  1. **Bearer (default)** — verifies `Authorization: Bearer vbn_live_…`
 *     against the unified `tokens` table (argon2id) and returns the parent
 *     token row that the caller will use to mint a child. Touches
 *     `last_used_at` best-effort.
 *  2. **Session fallback (opt-in)** — when no valid Bearer is present AND
 *     the caller opted in via `{ allowSessionFallback: { orgId | orgSlug } }`,
 *     resolve the Supabase session, verify org membership, and return the
 *     org's first carte-blanche root token (`scope='org', parent_id IS NULL,
 *     accepted_risks=[]`) as the virtual parent. This is what the dashboard
 *     mint UI uses — the user mints a child via session cookie instead of
 *     having to paste a vbn_live_* token in the browser.
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
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';

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

/**
 * Opt-in session fallback. When set, `requireToken` will attempt to resolve
 * the request via Supabase cookie session if no valid Bearer is present.
 *
 *  - `orgId` or `orgSlug` : the org we mint into. Membership is enforced.
 */
export interface SessionFallbackHint {
  orgId?: string;
  orgSlug?: string;
}

export interface RequireTokenOptions {
  /** When provided, enable the cookie-auth fallback. The session user must
   *  be a member of the target org ; we use its first carte-blanche root
   *  token (`scope='org', parent_id IS NULL`) as the virtual parent. */
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
 * Resolve the dashboard session into a virtual parent token. Used by the
 * mint UI which has a Supabase cookie session but no Bearer to paste.
 */
async function resolveSessionFallback(hint: SessionFallbackHint): Promise<TokenGuard> {
  const ssr = await getSupabaseServer();
  const { data: userRes } = await ssr.auth.getUser();
  if (!userRes.user) return unauthorized('session expired — sign in again.');

  const svc = getSupabaseServiceClient();

  // Resolve org id from hint.
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

  // Membership check — the user must belong to the org we mint into.
  const { data: member } = await svc
    .from('org_members')
    .select('user_id')
    .eq('organization_id', orgId)
    .eq('user_id', userRes.user.id)
    .maybeSingle<{ user_id: string }>();
  if (!member) return unauthorized('session fallback: user is not a member of this org.');

  // Pick the org's first active carte-blanche root token. The dashboard
  // creates these via /settings/management-keys ; we use ANY active one
  // as the parent for the child being minted.
  const { data: root } = await svc
    .from('tokens')
    .select(
      'id, name, organization_id, parent_id, scope, project_id, accepted_risks, denied_risks, depth, delegation_chain, status, expires_at, created_at, created_by',
    )
    .eq('organization_id', orgId)
    .eq('scope', 'org')
    .is('parent_id', null)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<Omit<TokenAuthRow, 'api_key_hash'>>();
  if (!root) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            'no active root token in this org — create one at /orgs/<slug>/settings/management-keys first.',
        },
        { status: 409 },
      ),
    };
  }

  return {
    ok: true,
    orgId: root.organization_id,
    token: {
      id: root.id,
      name: root.name,
      organization_id: root.organization_id,
      parent_id: root.parent_id,
      scope: root.scope,
      project_id: root.project_id,
      accepted_risks: toRiskArray(root.accepted_risks),
      denied_risks: toRiskArray(root.denied_risks),
      depth: root.depth,
      delegation_chain: toDelegationChain(root.delegation_chain),
      status: root.status,
      expires_at: root.expires_at,
      created_at: root.created_at,
      created_by: root.created_by,
    },
  };
}
