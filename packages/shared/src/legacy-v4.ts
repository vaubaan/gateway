/**
 * LEGACY v4 TYPES — quarantined, scheduled for deletion.
 *
 * Everything in this module mirrors the v4 SaaS model (organizations,
 * projects, provider bindings, project-scoped tokens) that the v5 spec
 * replaces with connections, resources and missions
 * (docs/spec/vaubaan-gateway.md §2). The v5 types live in `domain.ts`.
 *
 * Why it still exists : the ten provider plugins, `@vaubaan/gateway-core`'s
 * v4 pipeline and the v4 web app still compile against these names. They
 * migrate in features P1.2 (plugins) and P1.6 (execution door). Rules :
 *
 *   - no new consumer may import anything from this module ;
 *   - every symbol is `@deprecated` and names its v5 replacement ;
 *   - the module is deleted, with this barrel export, when the last
 *     consumer is gone (tracked in the P1.2 brief).
 *
 * Deleted outright at P0.2 (no consumer) : `EscalationChannel`,
 * `TokenContextPayload`, `narrowTokenContext`, `AccessTokenStatus`,
 * `ManagementKeyStatus`, `AccessToken`, `OrgManagementKey`, `RiskAcceptance`.
 */

import type { RiskId } from './risk.ts';

/** @deprecated v4 closed provider list. v5 : `PluginRegistry.ids` in `@vaubaan/plugin-sdk`. */
export type Provider =
  | 'github'
  | 'vercel'
  | 'supabase'
  | 'railway'
  | 'bash'
  | 'ssh'
  | 'upstash-redis'
  | 'gmail'
  | 'stripe'
  | 'cloudflare-dns'
  | 'resend';

/** @deprecated v4 closed provider list. v5 : `PluginRegistry.ids`. */
export const PROVIDERS = [
  'github',
  'vercel',
  'supabase',
  'railway',
  'bash',
  'ssh',
  'upstash-redis',
  'gmail',
  'stripe',
  'cloudflare-dns',
  'resend',
] as const satisfies readonly Provider[];

/** @deprecated resolves against the closed v4 list. v5 : `PluginRegistry.providerForTool`. */
export function providerForTool(toolName: string): Provider | null {
  for (const p of PROVIDERS) {
    if (toolName.startsWith(`${p.replaceAll('-', '_')}__`)) return p;
  }
  return null;
}

/** @deprecated v5 : `ConnectionStatus`. */
export type ProviderAdminStatus = 'connected' | 'expired' | 'revoked';

/** @deprecated v5 : `MissionTokenStatus`. */
export type TokenStatus = 'active' | 'revoked';

/** @deprecated v4 tokens were all project-scoped ; v5 missions have no scope column. */
export type TokenScope = 'project';

/** @deprecated machine-to-machine delegation is gone (pivot ADR amendment). */
export interface DelegationChainEntry {
  id: string;
  name: string;
  depth: number;
  scope: TokenScope;
  created_at: string;
  created_by: string | null;
}

/** @deprecated v5 has no tenant ; the instance is the trust domain. */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  created_at: string;
}

/** @deprecated v5 : `User` + `Group`. */
export interface OrgMember {
  organization_id: string;
  user_id: string;
  added_at: string;
}

/** @deprecated v5 : `Connection` (+ `Credential`). */
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

/** @deprecated v5 : `Mission` carries resources directly. */
export interface Project {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  created_by: string | null;
  created_at: string;
}

/** @deprecated v5 : `Resource` / `ConnectionResource`. */
export interface ProviderBinding {
  id: string;
  project_id: string;
  provider: Provider;
  resource_ref: string;
  display_name: string | null;
  /** The environment this binding targets, or null when the resource has no
   *  parallel instances. v5 : `Resource.env`. */
  environment?: string | null;
  /** Provider-specific bag needed at classification time. v5 : `Resource.metadata`. */
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

/** @deprecated v5 : `Mission` + `MissionToken`. */
export interface Token {
  id: string;
  organization_id: string;
  parent_id: string | null;
  scope: TokenScope;
  project_id: string;
  name: string;
  api_key_prefix: string;
  api_key_hash: string;
  status: TokenStatus;
  accepted_risks: RiskId[];
  denied_risks: RiskId[];
  depth: number;
  delegation_chain: DelegationChainEntry[];
  context: Record<string, unknown> | null;
  expires_at: string | null;
  single_use: boolean;
  consumed_at: string | null;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
}

/** @deprecated v5 : the gateway-core `AuditEntry` (P0.5). */
export interface AuditLogRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  access_token_id: string | null;
  ts: string;
  tool_name: string;
  arguments_hash: string;
  decision: 'allowed' | 'denied';
  denial_reason: string | null;
  upstream_latency_ms: number | null;
  client_ip: string | null;
  client_user_agent: string | null;
  slices_executed: unknown[] | null;
  risks_touched: string[] | null;
  token_accepted_risks_snapshot: string[] | null;
  delegation_chain: DelegationChainEntry[] | null;
}

/** @deprecated hot-path snapshot of a v4 token. v5 : the gateway-core `MissionContext` (P0.5). */
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
  accepted_risks: RiskId[];
  denied_risks: RiskId[];
  bindings: ProviderBinding[];
  provider_admins: Array<
    Pick<ProviderAdmin, 'provider' | 'status' | 'installation_id' | 'team_id'>
  >;
}

/** @deprecated structural alias of `TokenContext` with the pre-unification field name. */
export interface AccessTokenContext extends Omit<TokenContext, 'token'> {
  access_token: TokenContext['token'];
}
