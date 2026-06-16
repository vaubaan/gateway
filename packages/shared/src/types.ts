/**
 * Domain types shared across packages.
 * Mirrors the SQL schema from supabase/migrations/0001_init.sql + 0032.
 *
 * Spec : docs/spec/vaubaan-gateway.md §3.
 * ADR  : docs/decisions/unified-tokens-delegation-chain-and-escalation-channel.md
 *        (unified `tokens` table — drops the legacy AccessToken /
 *        OrgManagementKey duality).
 */

import type { RiskId } from './risk.ts';

export type Provider = 'github' | 'vercel' | 'supabase' | 'railway' | 'bash';

export const PROVIDERS = [
  'github',
  'vercel',
  'supabase',
  'railway',
  'bash',
] as const satisfies readonly Provider[];

export type ProviderAdminStatus = 'connected' | 'expired' | 'revoked';

export type TokenStatus = 'active' | 'revoked';

export type TokenScope = 'org' | 'project';

export type AuditDecision = 'allowed' | 'denied';

/** One entry in a token's `delegation_chain` jsonb array.
 *  Convention : root in `[0]`, parent direct in `[length-1]`.
 *  Root tokens (`parent_id IS NULL`) have `delegation_chain = []`.
 *  Cf. ADR unified-tokens-delegation-chain-and-escalation-channel.md §D2. */
export interface DelegationChainEntry {
  id: string;
  name: string;
  depth: number;
  scope: TokenScope;
  created_at: string;
  created_by: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  created_at: string;
}

export interface OrgMember {
  organization_id: string;
  user_id: string;
  added_at: string;
}

export interface ProviderAdmin {
  id: string;
  organization_id: string;
  provider: Provider;
  status: ProviderAdminStatus;
  installation_id: string | null;
  team_id: string | null;
  access_token_encrypted: Uint8Array | null;
  refresh_token_encrypted: Uint8Array | null;
  expires_at: string | null;
  connected_by_user_id: string | null;
  connected_at: string;
}

export interface Project {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  created_by: string | null;
  created_at: string;
}

export interface ProviderBinding {
  id: string;
  project_id: string;
  provider: Provider;
  resource_ref: string;
  display_name: string | null;
  /**
   * The named canonical environment this binding targets (e.g. 'staging',
   * 'prod'), or null when the bound resource has no parallel instances.
   * Backs the env segment of a slice for providers where env = a distinct
   * resource (Supabase: one project_ref per env). Mirrors the nullable
   * `provider_bindings.environment` column. Optional on the TS shape so legacy
   * binding literals stay valid; absent ≡ null.
   */
  environment?: string | null;
  created_at: string;
}

/**
 * Token row (table `tokens`).
 *
 * Unified replacement for the legacy (org_management_keys, access_tokens)
 * pair — cf. ADR unified-tokens-delegation-chain-and-escalation-channel.md.
 * A token is either org-scoped (`scope='org'`, no project) or project-scoped
 * (`scope='project'`, project_id set). It carries `accepted_risks` /
 * `denied_risks` directly + a `parent_id` self-FK + a pre-computed
 * `delegation_chain` snapshot.
 */
export interface Token {
  id: string;
  organization_id: string;
  parent_id: string | null;
  scope: TokenScope;
  /** Required when scope='project', null when scope='org'. */
  project_id: string | null;
  name: string;
  api_key_prefix: string;
  api_key_hash: string;
  status: TokenStatus;
  accepted_risks: RiskId[];
  denied_risks: RiskId[];
  /** 0 = root ; cap at 5 enforced by the SQL CHECK constraint. */
  depth: number;
  delegation_chain: DelegationChainEntry[];
  /** Free-form caller-supplied context (task, agent_id,
   *  escalation_channel, …). */
  context: Record<string, unknown> | null;
  /** ISO timestamp ; null = no TTL. When non-null and `now > expires_at`
   *  the gateway rejects the token with AuthError('token has expired'). */
  expires_at: string | null;
  /** When true the gateway consumes the token on the first matching /mcp
   *  call — status flips to 'revoked', consumed_at is set. */
  single_use: boolean;
  consumed_at: string | null;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface AuditLogRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  access_token_id: string | null;
  ts: string;
  tool_name: string;
  arguments_hash: string;
  decision: AuditDecision;
  denial_reason: string | null;
  upstream_latency_ms: number | null;
  client_ip: string | null;
  client_user_agent: string | null;
  /** v4 risk-based audit columns (migration 0028). Slices touched + risks
   *  matched + snapshot of the token's accepted risks at call time. */
  slices_executed: unknown[] | null;
  risks_touched: string[] | null;
  token_accepted_risks_snapshot: string[] | null;
  /** Snapshot of the token's delegation_chain at call time (migration 0034). */
  delegation_chain: DelegationChainEntry[] | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token context loaded at hot-path (cached 60s)
// ─────────────────────────────────────────────────────────────────────────────

/** Hot-path snapshot for an authenticated `vbn_live_*` Bearer.
 *
 *  Only project-scoped tokens (`scope='project'`) reach the MCP gateway —
 *  org-scoped tokens authenticate the /api/v1/tokens/* mint surface and
 *  never call `tools/call`. The shape therefore assumes a concrete project. */
export interface TokenContext {
  token: Pick<
    Token,
    | 'id'
    | 'name'
    | 'parent_id'
    | 'scope'
    | 'project_id'
    | 'status'
    | 'api_key_prefix'
    | 'expires_at'
    | 'single_use'
    | 'consumed_at'
    | 'depth'
    | 'delegation_chain'
  >;
  project: Pick<Project, 'id' | 'slug' | 'organization_id'>;
  organization: Pick<Organization, 'id' | 'slug' | 'name'>;
  /** v4 risk-based grants. The runtime intersects each call's slices with the
   *  provider catalog and checks the touched risks are all in this set. */
  accepted_risks: RiskId[];
  /** v4 explicit opt-outs. */
  denied_risks: RiskId[];
  bindings: ProviderBinding[];
  provider_admins: Array<
    Pick<ProviderAdmin, 'provider' | 'status' | 'installation_id' | 'team_id'>
  >;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP JSON-RPC primitives
// ─────────────────────────────────────────────────────────────────────────────

export interface McpToolDeclaration {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY TYPE ALIASES — kept for in-flight migration to the unified `tokens`
// table. New code should reference `Token`, `TokenContext`, etc. These will
// be removed after the in-tree callers are migrated (cf. unified-tokens ADR).
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated alias for `TokenStatus`. */
export type AccessTokenStatus = TokenStatus;
/** @deprecated alias for `TokenStatus`. */
export type ManagementKeyStatus = TokenStatus;

/** @deprecated alias for `Token` — project-scoped subset. */
export type AccessToken = Token;

/** @deprecated alias for `Token` — org-scoped subset. */
export type OrgManagementKey = Token;

/** @deprecated alias for `TokenContext`. The legacy shape exposed
 *  `access_token`; the new shape uses `token`. We keep a structural
 *  alias by mapping `access_token → token`. Code that still reads
 *  `ctx.access_token` should be migrated to `ctx.token`. */
export interface AccessTokenContext extends Omit<TokenContext, 'token'> {
  access_token: TokenContext['token'];
}
