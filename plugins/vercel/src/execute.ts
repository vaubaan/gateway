/**
 * Upstream calls of the `vercel` provider, and resource discovery.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 (the credential arrives decrypted
 *        in the context, is used for one call, never returned), §5.
 * ADRs : docs/decisions/rewrap-official-mcps.md (JSON-RPC forward to
 *        https://mcp.vercel.com/), docs/decisions/vercel-augment-with-rest-tools.md
 *        (custom tools on https://api.vercel.com).
 *
 * Two upstream surfaces, one bearer :
 *   - the 18 rewrapped tools are forwarded as a JSON-RPC `tools/call` to the
 *     official Vercel MCP server (HTTP + SSE framing, one frame per response) ;
 *   - the 13 custom tools hit the REST API directly.
 *
 * Rules :
 *   - `fetch` comes from the context, never from the global ;
 *   - 401 / 403 from either surface → `UpstreamAuthError`, so the host marks
 *     the connection `expired` ;
 *   - `teamId` is always the connection's team ; a different explicit value
 *     is refused before any network call ;
 *   - `projectId` absent → the mission's single project, when the tool's
 *     schema declares that argument.
 *
 * The response of `fetch` is only read through `ok`, `status` and `text()`,
 * so the legacy adapter tests (hand-rolled response objects) keep passing
 * until P1.6 deletes them.
 */

import {
  UpstreamAuthError,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { PROVIDER, VERCEL_ENVS } from './classify.ts';
import { vercelAuth } from './credential.ts';
import {
  ADD_DOMAIN,
  DELETE_ENV_VAR,
  GET_FIREWALL_CONFIG,
  LIST_DOMAINS,
  LIST_ENV_VARS,
  MANAGE_IP_BLOCKING,
  REMOVE_DOMAIN,
  REMOVE_FIREWALL_RULE,
  TOGGLE_FIREWALL,
  UPDATE_PROJECT_SETTINGS,
  UPSERT_ENV_VAR,
  UPSERT_FIREWALL_RULE,
  VERIFY_DOMAIN,
} from './custom-tools.ts';
import { isCustomTool, toUpstreamName, toolDeclaresProperty } from './tools.ts';

/** The official Vercel MCP server (rewrapped tools). A fact about the provider. */
export const VERCEL_MCP_URL = 'https://mcp.vercel.com/';
/** The Vercel REST API (custom tools, discovery). */
export const VERCEL_API_BASE = 'https://api.vercel.com';

/** Projects per page and pages walked by `discoverResources` (1 000 projects). */
export const DISCOVERY_PAGE_SIZE = 100;
export const DISCOVERY_MAX_PAGES = 10;

/** @deprecated legacy v4, deleted in P1.6. */
export type FetchImpl = typeof fetch;

/** What one upstream call needs. Built from the context by `execute`, by hand by the legacy adapter. */
export interface VercelCall {
  readonly fetch: typeof fetch;
  readonly token: string;
  /** The connection's team ; `null` only on the legacy path. */
  readonly teamId: string | null;
  readonly signal?: AbortSignal;
}

export interface CallOptions {
  /**
   * Legacy v4 behaviour : add `teamId` to every forwarded upstream call that
   * lacks one, whatever the tool's schema. The v5 path does its own
   * schema-aware injection and passes `false`.
   */
  readonly injectTeamId?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// v5 entry points
// ─────────────────────────────────────────────────────────────────────────────

export async function executeVercel(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const { token, teamId } = vercelAuth(ctx.credential);
  const call: VercelCall = {
    fetch: ctx.fetch,
    token,
    teamId,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };

  if (typeof args.teamId === 'string' && args.teamId !== teamId) {
    return errorResult(
      `teamId '${args.teamId}' is not the team of this connection ('${teamId}') — omit the argument.`,
    );
  }
  const finalArgs = normalizeArgs(tool, args, teamId, ctx.resources);

  try {
    return toToolResult(await callVercelTool(call, tool, finalArgs, { injectTeamId: false }));
  } catch (e) {
    if (e instanceof UpstreamAuthError) throw e;
    return errorResult(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Resources reachable with this credential : one `Resource` per project of
 * the connection's team, paged (`DISCOVERY_PAGE_SIZE` × `DISCOVERY_MAX_PAGES`).
 * The team is read first, which also validates the token. The environment
 * axis is not a resource : every project carries the three Vercel
 * environments, noted in `metadata.environments`, and the classifier derives
 * the one a call touches from its arguments.
 */
export async function discoverVercelResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const { token, teamId } = vercelAuth(ctx.credential);
  const call: VercelCall = {
    fetch: ctx.fetch,
    token,
    teamId,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };

  const team = (await callRest(
    call,
    'GET',
    `/v2/teams/${encodeURIComponent(teamId)}`,
    {},
    null,
  )) as {
    id?: string;
    slug?: string;
    name?: string;
  };

  const projects: ProjectDto[] = [];
  let until: number | undefined;
  for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
    const query: Record<string, string> = { teamId, limit: String(DISCOVERY_PAGE_SIZE) };
    if (until !== undefined) query.until = String(until);
    const body = (await callRest(call, 'GET', '/v10/projects', query, null)) as
      | ProjectDto[]
      | { projects?: ProjectDto[]; pagination?: { next?: number | null } };
    const batch = Array.isArray(body) ? body : (body.projects ?? []);
    projects.push(...batch);
    const next = Array.isArray(body) ? null : (body.pagination?.next ?? null);
    if (next === null || next === undefined || batch.length === 0) break;
    until = next;
  }

  return projects.map((p) => ({
    provider: PROVIDER,
    ref: p.id,
    displayName: p.name,
    metadata: {
      team_id: team.id ?? teamId,
      ...(team.slug ? { team_slug: team.slug } : {}),
      ...(team.name ? { team_name: team.name } : {}),
      framework: p.framework ?? null,
      /** The Vercel environment axis : resolved per call from `target`, not from an owner label. */
      environments: [...VERCEL_ENVS],
    },
  }));
}

interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly framework?: string | null;
}

/**
 * Fill the arguments the mission leaves no choice over : the connection's
 * team, and the single project of the mission, when the tool declares them.
 * Upstream tools declare `additionalProperties: false`, so nothing is added
 * to a tool whose schema does not have the property.
 */
function normalizeArgs(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  teamId: string,
  resources: readonly Resource[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (toolDeclaresProperty(tool, 'teamId') && out.teamId === undefined) out.teamId = teamId;
  if (toolDeclaresProperty(tool, 'projectId') && out.projectId === undefined) {
    const own = resources.filter((r) => r.provider === PROVIDER);
    if (own.length === 1) out.projectId = own[0]!.ref;
  }
  return out;
}

function toToolResult(payload: unknown): McpToolResult {
  if (isToolResult(payload)) return payload;
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** The upstream MCP server already answers with an `McpToolResult` ; pass it through. */
function isToolResult(x: unknown): x is McpToolResult {
  return (
    typeof x === 'object' &&
    x !== null &&
    Array.isArray((x as { content?: unknown }).content) &&
    (x as { content: unknown[] }).content.every(
      (c) =>
        typeof c === 'object' && c !== null && typeof (c as { type?: unknown }).type === 'string',
    )
  );
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core : one tool call → raw upstream payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run one tool against Vercel and return the raw payload : the JSON-RPC
 * `result` for rewrapped tools, the parsed REST body for custom tools.
 * Throws `UpstreamAuthError` on 401/403, a plain `Error` otherwise.
 */
export async function callVercelTool(
  call: VercelCall,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  options: CallOptions = {},
): Promise<unknown> {
  if (isCustomTool(tool)) return executeCustom(call, tool, args);
  const name = toUpstreamName(tool);
  const inject = options.injectTeamId ?? true;
  const finalArgs =
    inject && call.teamId && !('teamId' in args) ? { ...args, teamId: call.teamId } : args;
  return callUpstreamMcp(call, 'tools/call', { name, arguments: finalArgs });
}

/** @deprecated legacy v4, deleted in P1.6 — use `callVercelTool`. */
export async function executeCall(
  fetchImpl: FetchImpl,
  token: string,
  teamId: string | null,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return callVercelTool({ fetch: fetchImpl, token, teamId }, tool, args);
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream MCP (JSON-RPC over HTTP + SSE)
// ─────────────────────────────────────────────────────────────────────────────

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/**
 * Extract the first `data:` JSON payload of an SSE body that is a JSON-RPC
 * frame with the matching id (or a null id). The Vercel MCP server emits one
 * frame per response.
 */
function parseFirstJsonRpcFrame(body: string, id: number): JsonRpcResponse {
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (!payload) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'jsonrpc' in parsed &&
      ((parsed as { id?: unknown }).id === id || (parsed as { id?: unknown }).id === null)
    ) {
      return parsed as JsonRpcResponse;
    }
  }
  throw new Error(`No JSON-RPC frame matched id ${id} in upstream SSE response.`);
}

async function callUpstreamMcp(
  call: VercelCall,
  method: string,
  params: Record<string, unknown> | undefined,
  id = Math.floor(Math.random() * 1_000_000_000),
): Promise<unknown> {
  const res = await call.fetch(VERCEL_MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${call.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    ...(call.signal ? { signal: call.signal } : {}),
  });
  if (!res.ok) {
    const errText = await res.text();
    const msg = `Vercel MCP upstream ${res.status}: ${errText.slice(0, 300)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(msg, res.status);
    throw new Error(msg);
  }
  const frame = parseFirstJsonRpcFrame(await res.text(), id);
  if ('error' in frame) {
    throw new Error(`Vercel MCP upstream error ${frame.error.code}: ${frame.error.message}`);
  }
  return frame.result;
}

// ─────────────────────────────────────────────────────────────────────────────
// REST API (custom tools, discovery)
// ─────────────────────────────────────────────────────────────────────────────

async function callRest(
  call: VercelCall,
  method: 'GET' | 'PATCH' | 'POST' | 'DELETE',
  path: string,
  query: Record<string, string>,
  body: Record<string, unknown> | null,
): Promise<unknown> {
  const qs = new URLSearchParams(query).toString();
  const url = `${VERCEL_API_BASE}${path}${qs ? `?${qs}` : ''}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${call.token}`,
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers };
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (call.signal) init.signal = call.signal;
  const res = await call.fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    const msg = `Vercel REST ${method} ${path} ${res.status}: ${text.slice(0, 300)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(msg, res.status);
    throw new Error(msg);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pickDefined<T extends Record<string, unknown>>(
  args: T,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in args) out[k] = args[k];
  }
  return out;
}

const PROJECT_SETTINGS_FIELDS = [
  'rootDirectory',
  'framework',
  'buildCommand',
  'devCommand',
  'installCommand',
  'outputDirectory',
  'nodeVersion',
] as const;

const ENV_VAR_FIELDS = ['key', 'value', 'target', 'type', 'gitBranch', 'comment'] as const;
const ADD_DOMAIN_FIELDS = [
  'name',
  'gitBranch',
  'redirect',
  'redirectStatusCode',
  'customEnvironmentId',
] as const;

async function executeCustom(
  call: VercelCall,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const projectId = typeof args.projectId === 'string' ? args.projectId : '';
  if (!projectId) throw new Error(`Vercel custom tool ${tool}: projectId is required.`);
  const effectiveTeamId = typeof args.teamId === 'string' ? args.teamId : call.teamId;
  const query: Record<string, string> = {};
  if (effectiveTeamId) query.teamId = effectiveTeamId;
  const project = encodeURIComponent(projectId);

  if (tool === UPDATE_PROJECT_SETTINGS) {
    const body = pickDefined(args, PROJECT_SETTINGS_FIELDS);
    return callRest(call, 'PATCH', `/v9/projects/${project}`, query, body);
  }
  if (tool === UPSERT_ENV_VAR) {
    query.upsert = 'true';
    const body = pickDefined(args, ENV_VAR_FIELDS);
    return callRest(call, 'POST', `/v10/projects/${project}/env`, query, body);
  }
  if (tool === LIST_ENV_VARS) {
    if (args.decrypt === true) query.decrypt = 'true';
    return callRest(call, 'GET', `/v10/projects/${project}/env`, query, null);
  }
  if (tool === DELETE_ENV_VAR) {
    const envVarId = typeof args.id === 'string' ? args.id : '';
    if (!envVarId) throw new Error(`Vercel custom tool ${tool}: id is required.`);
    return callRest(
      call,
      'DELETE',
      `/v9/projects/${project}/env/${encodeURIComponent(envVarId)}`,
      query,
      null,
    );
  }
  if (tool === LIST_DOMAINS) {
    return callRest(call, 'GET', `/v9/projects/${project}/domains`, query, null);
  }
  if (tool === ADD_DOMAIN) {
    if (typeof args.name !== 'string') {
      throw new Error(`Vercel custom tool ${tool}: name is required.`);
    }
    const body = pickDefined(args, ADD_DOMAIN_FIELDS);
    return callRest(call, 'POST', `/v10/projects/${project}/domains`, query, body);
  }
  if (tool === VERIFY_DOMAIN) {
    const domain = typeof args.domain === 'string' ? args.domain : '';
    if (!domain) throw new Error(`Vercel custom tool ${tool}: domain is required.`);
    return callRest(
      call,
      'POST',
      `/v9/projects/${project}/domains/${encodeURIComponent(domain)}/verify`,
      query,
      {},
    );
  }
  if (tool === REMOVE_DOMAIN) {
    const domain = typeof args.domain === 'string' ? args.domain : '';
    if (!domain) throw new Error(`Vercel custom tool ${tool}: domain is required.`);
    return callRest(
      call,
      'DELETE',
      `/v9/projects/${project}/domains/${encodeURIComponent(domain)}`,
      query,
      null,
    );
  }

  // ─── Firewall / WAF tools ───────────────────────────────────────────────

  if (tool === GET_FIREWALL_CONFIG) {
    query.projectId = projectId;
    return callRest(call, 'GET', '/v1/security/firewall/config/active', query, null);
  }
  if (tool === TOGGLE_FIREWALL) {
    if (typeof args.enabled !== 'boolean') {
      throw new Error(`Vercel custom tool ${tool}: enabled (boolean) is required.`);
    }
    query.projectId = projectId;
    return callRest(call, 'PATCH', '/v1/security/firewall/config', query, {
      action: 'firewallEnabled',
      value: args.enabled,
    });
  }
  if (tool === UPSERT_FIREWALL_RULE) {
    if (typeof args.name !== 'string') {
      throw new Error(`Vercel custom tool ${tool}: name is required.`);
    }
    query.projectId = projectId;
    const ruleValue = pickDefined(args, [
      'name',
      'description',
      'active',
      'conditionGroup',
      'action',
    ]);
    const ruleId = typeof args.ruleId === 'string' ? args.ruleId : null;
    const body: Record<string, unknown> = ruleId
      ? { action: 'rules.update', id: ruleId, value: ruleValue }
      : { action: 'rules.insert', value: ruleValue };
    return callRest(call, 'PATCH', '/v1/security/firewall/config', query, body);
  }
  if (tool === REMOVE_FIREWALL_RULE) {
    const ruleId = typeof args.ruleId === 'string' ? args.ruleId : '';
    if (!ruleId) throw new Error(`Vercel custom tool ${tool}: ruleId is required.`);
    query.projectId = projectId;
    return callRest(call, 'PATCH', '/v1/security/firewall/config', query, {
      action: 'rules.remove',
      id: ruleId,
    });
  }
  if (tool === MANAGE_IP_BLOCKING) {
    const operation = typeof args.operation === 'string' ? args.operation : '';
    if (operation !== 'insert' && operation !== 'remove') {
      throw new Error(`Vercel custom tool ${tool}: operation must be 'insert' or 'remove'.`);
    }
    query.projectId = projectId;
    if (operation === 'insert') {
      if (typeof args.ip !== 'string' || !args.ip) {
        throw new Error(`Vercel custom tool ${tool}: ip is required for insert.`);
      }
      const value = pickDefined(args, ['hostname', 'ip', 'action', 'notes']);
      return callRest(call, 'PATCH', '/v1/security/firewall/config', query, {
        action: 'ip.insert',
        value,
      });
    }
    const ipRuleId = typeof args.id === 'string' ? args.id : '';
    if (!ipRuleId) {
      throw new Error(`Vercel custom tool ${tool}: id is required for remove.`);
    }
    return callRest(call, 'PATCH', '/v1/security/firewall/config', query, {
      action: 'ip.remove',
      id: ipRuleId,
    });
  }

  throw new Error(`Vercel custom tool not implemented: ${tool}`);
}
