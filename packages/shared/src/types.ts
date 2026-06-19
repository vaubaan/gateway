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

export type Provider =
  | 'github'
  | 'vercel'
  | 'supabase'
  | 'railway'
  | 'bash'
  | 'upstash-redis'
  | 'gmail'
  | 'stripe';

export const PROVIDERS = [
  'github',
  'vercel',
  'supabase',
  'railway',
  'bash',
  'upstash-redis',
  'gmail',
  'stripe',
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
  /**
   * Provider-specific JSONB bag for configuration that doesn't fit anywhere
   * else on the row but is needed at classification time. Examples (Gmail) :
   * `internal_domains`, `allowlist_addresses`, `allowlist_domains`,
   * `sensitive_labels`. Stays opaque from the gateway's POV — each provider
   * plugin types and consumes the shape it expects.
   *
   * Optional on the TS shape so legacy binding literals (without metadata)
   * stay valid; absent ≡ {}.
   */
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Runtime escalation channel — opaque-to-gateway HTTP endpoint a child token
 * carries to ask its parent for a re-mint with wider scope when it hits a
 * `risk-not-accepted` 403.
 *
 * The gateway does NOT validate `endpoint_url`, does NOT sign or rotate
 * `auth_token`, and does NOT proxy the escalation. The shape is published
 * here so SDKs and the dashboard can typecheck the field they pull out of
 * `token.context.escalation_channel`. The runtime contract is documented in
 * `docs/handbook/escalation.md` and ADR
 * `unified-tokens-delegation-chain-and-escalation-channel.md` §D4.
 */
export interface EscalationChannel {
  /** Only `'http'` in MVP. Kept as a discriminator so future transports
   *  (`'mcp'`, …) can be added without breaking the type. */
  transport: 'http';
  /** Absolute URL the child posts to (POST {endpoint_url}). */
  endpoint_url: string;
  /** Bearer secret the child sends to the parent (Authorization header).
   *  Shared-secret model — out of Vaubaan's scope to rotate. */
  auth_token: string;
}

/**
 * Type-aid for the free-form context attached to a token at mint time
 * (the value stored in `tokens.context jsonb`). The gateway only persists
 * / surfaces it ; nothing here is interpreted at runtime *by the gateway*.
 * SDKs are expected to read what they wrote (e.g. an agent SDK reads
 * `escalation_channel`, an orchestrator reads `agent_id`).
 *
 * The shape is loose by design (any extra key is allowed) ; this interface
 * just documents the well-known fields so downstream readers don't have to
 * narrow `unknown` themselves. The stored DB shape stays
 * `Record<string, unknown> | null` — use {@link narrowTokenContext} to lift
 * a raw jsonb value into `TokenContextPayload`.
 *
 * NOTE : distinct from {@link TokenContext}, which is the hot-path snapshot
 * loaded by the gateway for `/mcp` calls. The naming overlap is historical
 * and is documented in handbook escalation.md §2.
 */
export interface TokenContextPayload {
  /** Short human label naming the task this token serves (e.g. "feature-auth"). */
  task?: string;
  /** Free-form caller agent id (orchestrator-defined). */
  agent_id?: string;
  /** Optional runtime escalation channel ; absent on root tokens. */
  escalation_channel?: EscalationChannel;
}

/**
 * Lift a raw jsonb value (typed `Record<string, unknown>` post-DB-load) into
 * the readable {@link TokenContextPayload} shape. Returns an empty payload
 * when the input is null/undefined. Pure ; does no validation of the inner
 * EscalationChannel — readers stay responsible for that when they actually
 * use the field.
 */
export function narrowTokenContext(
  raw: Record<string, unknown> | null | undefined,
): TokenContextPayload {
  if (!raw) return {};
  const out: TokenContextPayload = {};
  if (typeof raw.task === 'string') out.task = raw.task;
  if (typeof raw.agent_id === 'string') out.agent_id = raw.agent_id;
  const ec = raw.escalation_channel;
  if (
    ec &&
    typeof ec === 'object' &&
    !Array.isArray(ec) &&
    (ec as Record<string, unknown>).transport === 'http' &&
    typeof (ec as Record<string, unknown>).endpoint_url === 'string' &&
    typeof (ec as Record<string, unknown>).auth_token === 'string'
  ) {
    out.escalation_channel = ec as EscalationChannel;
  }
  return out;
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
   *  escalation_channel, …). Stored as jsonb ; consumers can lift this into
   *  the documented {@link TokenContextPayload} shape via
   *  {@link narrowTokenContext}. */
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
