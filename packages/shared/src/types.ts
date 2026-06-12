/**
 * Domain types shared across packages.
 * Mirrors the SQL schema from supabase/migrations/0001_init.sql.
 *
 * Spec : docs/spec/vaubaan-gateway.md §3.
 */

import type { Capability } from './capability.ts';

export type Provider = 'github' | 'vercel' | 'supabase' | 'railway' | 'bash';

export const PROVIDERS = [
  'github',
  'vercel',
  'supabase',
  'railway',
  'bash',
] as const satisfies readonly Provider[];

export type ProviderAdminStatus = 'connected' | 'expired' | 'revoked';

export type AccessTokenStatus = 'active' | 'revoked';

export type AuditDecision = 'allowed' | 'denied';

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
   * Backs the `env` of a Capability for providers where env = a distinct
   * resource (Supabase: one project_ref per env). Mirrors the nullable
   * `provider_bindings.environment` column (migration 0011). Optional on the
   * TS shape so legacy binding literals stay valid; absent ≡ null.
   */
  environment?: string | null;
  created_at: string;
}

export interface AccessToken {
  id: string;
  project_id: string;
  name: string;
  api_key_prefix: string;
  api_key_hash: string;
  status: AccessTokenStatus;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
  /** ISO timestamp ; null = no TTL (UI-issued long-lived token).
   *  When non-null and `now > expires_at` the gateway rejects the token
   *  with AuthError('access token expired'). */
  expires_at: string | null;
  /** When true, the gateway consumes the token on the first /mcp call that
   *  matches a granted capability — status flips to 'revoked', consumed_at
   *  is set, and every subsequent call rejects (spec §8, single-use). */
  single_use: boolean;
  /** ISO timestamp of the consume event ; null until the first matching call
   *  (or for non-single-use tokens). */
  consumed_at: string | null;
}

export type ManagementKeyStatus = 'active' | 'revoked';

export interface OrgManagementKey {
  id: string;
  organization_id: string;
  name: string;
  api_key_prefix: string;
  api_key_hash: string;
  status: ManagementKeyStatus;
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
  /** Shorthand of the capability that authorized the call ; null if denied.
   *  Cf. capability.ts formatCapability(). */
  capability_matched: string | null;
  decision: AuditDecision;
  denial_reason: string | null;
  upstream_latency_ms: number | null;
  client_ip: string | null;
  client_user_agent: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Access-token context loaded at hot-path (cached 60s)
// ─────────────────────────────────────────────────────────────────────────────

export interface AccessTokenContext {
  access_token: Pick<
    AccessToken,
    | 'id'
    | 'name'
    | 'project_id'
    | 'status'
    | 'api_key_prefix'
    | 'expires_at'
    | 'single_use'
    | 'consumed_at'
  >;
  project: Pick<Project, 'id' | 'slug' | 'organization_id'>;
  organization: Pick<Organization, 'id' | 'slug' | 'name'>;
  /** The capability set granted to this access token (the full tuples). */
  capabilities: Capability[];
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

/**
 * How a tool's `env` is determined at `tools/call` time. Drives the lockstep
 * between the catalog's `callable` flag, `tools/list` filtering, and the
 * runtime `covers()` 5-tuple match (spec §3, §7).
 *
 *  - `'static'`  : the required capability is **env-less** regardless of
 *                  args. The runtime enforces an exact 5-tuple match
 *                  (env-less ↔ env-less). Therefore the static filter must
 *                  also require an env-less grant — an `@prod` grant does NOT
 *                  make this tool callable. Examples : `vercel__list_deployments`,
 *                  most GitHub reads.
 *  - `'runtime'` : the required capability's `env` is resolved from args
 *                  (or from the matched binding) at call time, ranging over
 *                  a per-provider env vocabulary. The static filter ignores
 *                  env (any env-qualified grant on the same 4-tuple is a
 *                  potential match) — the actual env defensive check then
 *                  happens at `tools/call`. Examples : `vercel__upsert_env_var`
 *                  (env from `args.target`), every Supabase tool (env from
 *                  the binding), `github__create_branch` (env from
 *                  `args.branch`).
 */
export type EnvResolution = 'static' | 'runtime';

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
