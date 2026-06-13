/**
 * Vercel tool dispatcher — JSON-RPC forward to the official Vercel MCP server,
 * with a fallback to direct REST calls for the custom tools defined in
 * `custom-tools.ts`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7.4.
 * ADRs :
 *   - docs/decisions/rewrap-official-mcps.md          (upstream forward)
 *   - docs/decisions/vercel-augment-with-rest-tools.md (custom tools)
 *
 * Upstream serves at https://mcp.vercel.com/ via HTTP+SSE. We forward our own
 * `tools/call` payload (with the `vercel__` prefix stripped) and parse the
 * SSE-framed JSON response. Custom tools (e.g. `vercel__update_project_settings`)
 * are routed directly to https://api.vercel.com/v9 instead.
 */

import { isCustomTool, toUpstreamName } from './tools.ts';
import {
  ADD_DOMAIN,
  DELETE_ENV_VAR,
  LIST_DOMAINS,
  LIST_ENV_VARS,
  REMOVE_DOMAIN,
  UPDATE_DEPLOYMENT_PROTECTION,
  UPDATE_PROJECT_SETTINGS,
  UPSERT_ENV_VAR,
  VERIFY_DOMAIN,
} from './custom-tools.ts';

export type FetchImpl = typeof fetch;

const UPSTREAM_MCP = 'https://mcp.vercel.com/';
const REST_BASE = 'https://api.vercel.com';

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
 * Parse a Server-Sent Events response body to extract the first `data:` JSON
 * payload that contains either a `result` or an `error` field with the matching
 * id. The Vercel MCP server emits one frame per response.
 */
function parseFirstJsonRpcFrame(body: string, id: number): JsonRpcResponse {
  const lines = body.split('\n');
  for (const line of lines) {
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
  fetchImpl: FetchImpl,
  token: string,
  method: string,
  params: Record<string, unknown> | undefined,
  id = Math.floor(Math.random() * 1_000_000_000),
): Promise<unknown> {
  const res = await fetchImpl(UPSTREAM_MCP, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vercel MCP upstream ${res.status}: ${errText.slice(0, 300)}`);
  }
  const body = await res.text();
  const frame = parseFirstJsonRpcFrame(body, id);
  if ('error' in frame) {
    throw new Error(`Vercel MCP upstream error ${frame.error.code}: ${frame.error.message}`);
  }
  return frame.result;
}

async function callRest(
  fetchImpl: FetchImpl,
  token: string,
  method: 'GET' | 'PATCH' | 'POST' | 'DELETE',
  path: string,
  query: Record<string, string>,
  body: Record<string, unknown> | null,
): Promise<unknown> {
  const qs = new URLSearchParams(query).toString();
  const url = `${REST_BASE}${path}${qs ? `?${qs}` : ''}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers };
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Vercel REST ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
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
const PROTECTION_FIELDS = ['ssoProtection', 'passwordProtection'] as const;

async function executeCustom(
  fetchImpl: FetchImpl,
  token: string,
  teamId: string | null,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const projectId = typeof args.projectId === 'string' ? args.projectId : '';
  if (!projectId) throw new Error(`Vercel custom tool ${tool}: projectId is required.`);
  const effectiveTeamId = typeof args.teamId === 'string' ? args.teamId : teamId;
  const query: Record<string, string> = {};
  if (effectiveTeamId) query.teamId = effectiveTeamId;

  if (tool === UPDATE_PROJECT_SETTINGS) {
    const body = pickDefined(args, PROJECT_SETTINGS_FIELDS);
    return callRest(fetchImpl, token, 'PATCH', `/v9/projects/${projectId}`, query, body);
  }
  if (tool === UPSERT_ENV_VAR) {
    query.upsert = 'true';
    const body = pickDefined(args, ENV_VAR_FIELDS);
    return callRest(fetchImpl, token, 'POST', `/v10/projects/${projectId}/env`, query, body);
  }
  if (tool === LIST_ENV_VARS) {
    if (args.decrypt === true) query.decrypt = 'true';
    return callRest(fetchImpl, token, 'GET', `/v10/projects/${projectId}/env`, query, null);
  }
  if (tool === DELETE_ENV_VAR) {
    const envVarId = typeof args.id === 'string' ? args.id : '';
    if (!envVarId) throw new Error(`Vercel custom tool ${tool}: id is required.`);
    return callRest(
      fetchImpl,
      token,
      'DELETE',
      `/v9/projects/${projectId}/env/${envVarId}`,
      query,
      null,
    );
  }
  if (tool === LIST_DOMAINS) {
    return callRest(fetchImpl, token, 'GET', `/v9/projects/${projectId}/domains`, query, null);
  }
  if (tool === ADD_DOMAIN) {
    if (typeof args.name !== 'string') {
      throw new Error(`Vercel custom tool ${tool}: name is required.`);
    }
    const body = pickDefined(args, ADD_DOMAIN_FIELDS);
    return callRest(fetchImpl, token, 'POST', `/v10/projects/${projectId}/domains`, query, body);
  }
  if (tool === VERIFY_DOMAIN) {
    const domain = typeof args.domain === 'string' ? args.domain : '';
    if (!domain) throw new Error(`Vercel custom tool ${tool}: domain is required.`);
    return callRest(
      fetchImpl,
      token,
      'POST',
      `/v9/projects/${projectId}/domains/${encodeURIComponent(domain)}/verify`,
      query,
      {},
    );
  }
  if (tool === REMOVE_DOMAIN) {
    const domain = typeof args.domain === 'string' ? args.domain : '';
    if (!domain) throw new Error(`Vercel custom tool ${tool}: domain is required.`);
    return callRest(
      fetchImpl,
      token,
      'DELETE',
      `/v9/projects/${projectId}/domains/${encodeURIComponent(domain)}`,
      query,
      null,
    );
  }
  if (tool === UPDATE_DEPLOYMENT_PROTECTION) {
    const body = pickDefined(args, PROTECTION_FIELDS);
    return callRest(fetchImpl, token, 'PATCH', `/v9/projects/${projectId}`, query, body);
  }
  throw new Error(`Vercel custom tool not implemented: ${tool}`);
}

export async function executeCall(
  fetchImpl: FetchImpl,
  token: string,
  teamId: string | null,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (isCustomTool(tool)) {
    return executeCustom(fetchImpl, token, teamId, tool, args);
  }
  // The upstream tool name (without the vercel__ prefix).
  const name = toUpstreamName(tool);
  // Many tools require `teamId` ; inject from the admin's stored team_id when
  // the caller didn't pass one explicitly.
  const finalArgs = teamId && !('teamId' in args) ? { ...args, teamId } : args;
  return callUpstreamMcp(fetchImpl, token, 'tools/call', { name, arguments: finalArgs });
}
