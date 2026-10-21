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
 *   - a provider failure is **thrown**, never returned : 401 / 403 from
 *     either surface → `UpstreamAuthError` (the host marks the connection
 *     `expired` on a 401), any other failed status → `UpstreamHttpError`,
 *     a JSON-RPC error frame or a network failure → the error itself. The
 *     host records it as `upstream_error` in the audit ;
 *   - what this executor declines itself (an argument it cannot read, a
 *     target outside the mission, a deployment it could not bind) is an
 *     `ExecutorRefusal`, returned as an `isError` result ;
 *   - the team is the credential's `team_id`, and nothing else : a `teamId`
 *     argument that is not exactly that value (another string, a non-string)
 *     is refused before any network call, and the value sent upstream is
 *     always written from the credential, on both surfaces ;
 *   - the project is the one the classifier resolved (`resolveProject`, the
 *     same function) : the argument is overwritten with it, never forwarded
 *     as received ;
 *   - a tool addressed by a deployment id or URL is forwarded only after the
 *     deployment was resolved through the REST API under the pinned team and
 *     found to belong to that project (`bindDeployments`) ;
 *   - a tool that cannot be bound to a project (`UNBOUND_TOOLS`), an unknown
 *     tool, or a rewrapped tool that cannot carry the team and was not
 *     reviewed (`TEAMLESS_UPSTREAM_TOOLS`) is refused.
 */

import {
  UpstreamAuthError,
  UpstreamHttpError,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import {
  domainName,
  isAccountTool,
  isClassifiedTool,
  MALFORMED_DOMAIN,
  MALFORMED_DOMAIN_NAME,
  MALFORMED_ENV_VAR_ID,
  pathIdent,
  PROVIDER,
  readDeploymentTargets,
  resolveProject,
  unboundToolDenial,
  UNBOUND_TOOLS,
  undeclaredArgument,
  VERCEL_ENVS,
} from './classify.ts';
import { vercelAuth } from './credential.ts';
import { PROJECT_TOOLS, redactProjectResult } from './project-redact.ts';
import { redactEncryptedEnvListing } from './redact.ts';
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
import { isCustomTool, toUpstreamName, toolAcceptsArgument, vercelToolByName } from './tools.ts';

/** The official Vercel MCP server (rewrapped tools). A fact about the provider. */
export const VERCEL_MCP_URL = 'https://mcp.vercel.com/';
/** The Vercel REST API (custom tools, discovery). */
export const VERCEL_API_BASE = 'https://api.vercel.com';

/** Projects per page and pages walked by `discoverResources` (1 000 projects). */
export const DISCOVERY_PAGE_SIZE = 100;
export const DISCOVERY_MAX_PAGES = 10;

/**
 * Rewrapped tools whose upstream schema is closed and has no `teamId` : the
 * forward cannot carry the connection's team. Each one is reviewed here, with
 * the reason the call stays inside the pinned team. A rewrapped tool in that
 * situation and absent from this list is refused by `execute`.
 */
export const TEAMLESS_UPSTREAM_TOOLS: Readonly<Record<string, string>> = {
  vercel__search_vercel_documentation:
    'Public documentation search : the answer does not depend on a team and reads no team data.',
  vercel__check_domain_availability_and_price:
    'Registrar lookup of public availability and price : reads no team data.',
  vercel__get_access_to_vercel_url:
    'Addressed by URL : the deployment is first resolved through the REST API under the pinned team and must belong to the mission project.',
  vercel__web_fetch_vercel_url:
    'Addressed by URL : the deployment is first resolved through the REST API under the pinned team and must belong to the mission project.',
};

/**
 * A call this executor declines itself : nothing failed at the provider. The
 * only error `executeVercel` turns into an `isError` result ; everything else
 * it lets through, so the host records a provider failure as one.
 */
class ExecutorRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorRefusal';
  }
}

/** Lookup answers that mean "this team cannot see that deployment". */
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

/** What one upstream call needs, built from the context. */
interface VercelCall {
  readonly fetch: typeof fetch;
  readonly token: string;
  /** The connection's team. */
  readonly teamId: string;
  readonly signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin entry points
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

  const pinned = pinArgs(tool, args, teamId, ctx.resources);
  if ('refused' in pinned) return errorResult(pinned.refused);

  try {
    const finalArgs = await bindDeployments(call, tool, pinned.args, pinned.projectRef);
    const result = toToolResult(await callVercelTool(call, tool, finalArgs));
    // A project object carries env values and deploy-hook URLs (`project-redact.ts`).
    return PROJECT_TOOLS.has(tool) ? redactProjectResult(result) : result;
  } catch (e) {
    if (e instanceof ExecutorRefusal) return errorResult(e.message);
    throw e;
  }
}

/**
 * Resources reachable with this credential : one `Resource` per project of
 * the connection's team, paged (`DISCOVERY_PAGE_SIZE` × `DISCOVERY_MAX_PAGES`).
 * The team is read first, which also validates the token. A token scoped to
 * some projects is refused every team-level read (403) : the team's name and
 * slug are then left out, and the project listing validates the token. The environment
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

  const team = await readTeam(call, teamId);

  const projects: ProjectDto[] = [];
  let until: number | undefined;
  for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
    const query: Record<string, string> = { teamId, limit: String(DISCOVERY_PAGE_SIZE) };
    if (until !== undefined) query.until = String(until);
    const body = (await callRest(call, 'GET', '/v10/projects', query, null)) as
      ProjectDto[] | { projects?: ProjectDto[]; pagination?: { next?: number | null } };
    const batch = Array.isArray(body) ? body : (body.projects ?? []);
    projects.push(...batch);
    const next = Array.isArray(body) ? null : (body.pagination?.next ?? null);
    if (next === null || next === undefined || batch.length === 0) break;
    until = next;
  }

  // A ref the classifier would refuse is of no use to a mission : say so at
  // connection time instead of listing a resource no call can name.
  const unusable = projects.find((p) => pathIdent(p.id) === null);
  if (unusable) {
    throw new Error(
      `${PROVIDER}: project id ${JSON.stringify(unusable.id)} is not a path-safe identifier`,
    );
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

interface TeamDto {
  readonly id?: string;
  readonly slug?: string;
  readonly name?: string;
}

/** The team, or nothing when the token may not read it (a token scoped to projects). */
async function readTeam(call: VercelCall, teamId: string): Promise<TeamDto> {
  try {
    return (await callRest(
      call,
      'GET',
      `/v2/teams/${encodeURIComponent(teamId)}`,
      {},
      null,
    )) as TeamDto;
  } catch (e) {
    if (e instanceof UpstreamAuthError && e.upstreamStatus === HTTP_FORBIDDEN) return {};
    throw e;
  }
}

interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly framework?: string | null;
}

type PinnedArgs =
  | { readonly args: Record<string, unknown>; readonly projectRef: string | null }
  | { readonly refused: string };

/**
 * Write the two arguments the mission leaves no choice over — the team of the
 * credential and the project the classifier resolved — and refuse what cannot
 * be pinned. No network call.
 *
 * The caller's `teamId` and `projectId` are never copied : they are checked,
 * dropped, then written again from the credential and from `resolveProject`
 * wherever the tool can receive them (declared property, or open schema).
 */
function pinArgs(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  teamId: string,
  resources: readonly Resource[],
): PinnedArgs {
  if (UNBOUND_TOOLS.has(tool)) return { refused: unboundToolDenial(tool) };
  if (!isClassifiedTool(tool) || vercelToolByName(tool) === undefined) {
    return { refused: `unknown vercel tool '${tool}'.` };
  }
  if (args.teamId !== undefined && args.teamId !== teamId) {
    return {
      refused: `teamId is fixed by the connection ('${teamId}') : the value given is not the team of this connection — omit the argument.`,
    };
  }
  const project = resolveProject(args, resources, !isAccountTool(tool));
  if ('denied' in project) return { refused: project.denied };
  // Everything else is forwarded as given : only what the tool declares may be there.
  const undeclared = undeclaredArgument(tool, args);
  if (undeclared !== null) return { refused: undeclared };

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'teamId' && key !== 'projectId') out[key] = value;
  }
  if (toolAcceptsArgument(tool, 'teamId')) {
    out.teamId = teamId;
  } else if (!Object.hasOwn(TEAMLESS_UPSTREAM_TOOLS, tool)) {
    return {
      refused: `${tool}: the upstream tool cannot carry the team of this connection and has not been reviewed — refused.`,
    };
  }
  if (project.ref !== null && !isAccountTool(tool) && toolAcceptsArgument(tool, 'projectId')) {
    out.projectId = project.ref;
  }
  return { args: out, projectRef: project.ref };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deployment binding : the deployment a call names belongs to the mission project
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(x: unknown): x is Readonly<Record<string, unknown>> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Resolve a deployment through the REST API **under the pinned team** and
 * return its id, after checking it belongs to `projectRef`. Throws an
 * `ExecutorRefusal` (a refusal the agent reads) when the team cannot see it
 * (403 or 404 on the lookup), when the answer does not name its project, or
 * when the project is another one.
 *
 * A 403 here is about the deployment the caller named, not about the token :
 * it is a refusal, not an upstream failure. A 401, a 5xx or a network failure
 * of the lookup is the provider's and is thrown unchanged.
 */
async function verifiedDeploymentId(
  call: VercelCall,
  key: string,
  projectRef: string,
): Promise<string> {
  const unverified = `deployment '${key}' could not be verified as a deployment of vercel project '${projectRef}' in the team of this connection`;
  let body: unknown;
  try {
    body = await callRest(
      call,
      'GET',
      `/v13/deployments/${encodeURIComponent(key)}`,
      { teamId: call.teamId },
      null,
    );
  } catch (e) {
    // 403 / 404 : the team of this connection cannot see that deployment. Any
    // other failure (401, 5xx, the network) is the provider's and is thrown as is.
    const hidden =
      (e instanceof UpstreamAuthError && e.upstreamStatus === HTTP_FORBIDDEN) ||
      (e instanceof UpstreamHttpError && e.status === HTTP_NOT_FOUND);
    if (!hidden) throw e;
    throw new ExecutorRefusal(`${unverified} : ${e.message}`);
  }
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.projectId !== 'string') {
    throw new ExecutorRefusal(`${unverified} : the lookup did not name its project.`);
  }
  if (body.ownerId !== undefined && body.ownerId !== call.teamId) {
    throw new ExecutorRefusal(`${unverified} : it is owned by another team.`);
  }
  if (body.projectId !== projectRef) {
    throw new ExecutorRefusal(
      `deployment '${key}' does not belong to vercel project '${projectRef}' of this mission.`,
    );
  }
  return body.id;
}

/**
 * For a rewrapped tool, verify every deployment argument its schema declares
 * and rewrite it : the verified deployment id for `idOrUrl` / `deploymentId`,
 * the normalised URL for `url`. The arguments are read by the classifier's
 * own `readDeploymentTargets` (schema-driven, so a tool added upstream with
 * one of these arguments is bound without a code change) : what it denied
 * there is refused here, before the first lookup, at no network cost.
 */
async function bindDeployments(
  call: VercelCall,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  projectRef: string | null,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...args };
  const read = readDeploymentTargets(tool, args);
  if ('denied' in read) throw new ExecutorRefusal(read.denied);
  const { targets } = read;
  if (targets.length === 0) return out;
  if (projectRef === null) {
    throw new ExecutorRefusal(
      `${tool}: a deployment cannot be verified without a project of this mission.`,
    );
  }
  for (const target of targets) {
    const id = await verifiedDeploymentId(call, target.key, projectRef);
    out[target.arg] = target.href ?? id;
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
 * Throws `UpstreamAuthError` on 401/403, `UpstreamHttpError` on any other
 * failed status, `ExecutorRefusal` for an argument the executor declines.
 */
async function callVercelTool(
  call: VercelCall,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (isCustomTool(tool)) return executeCustom(call, tool, args);
  return callUpstreamMcp(call, 'tools/call', { name: toUpstreamName(tool), arguments: args });
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
    throw new UpstreamHttpError(msg, res.status);
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
    throw new UpstreamHttpError(msg, res.status);
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
  // `pinArgs` wrote the project the classifier resolved ; the team is the credential's.
  // Every identifier below went through the classifier's own grammar
  // (`pathIdent`, `domainName`) : one path segment each, interpolated as it is.
  const project = pathIdent(args.projectId);
  if (project === null) {
    throw new ExecutorRefusal(`Vercel custom tool ${tool}: projectId is required.`);
  }
  const query: Record<string, string> = { teamId: call.teamId };

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
    // `decrypt=true` is the plaintext read (`read-env-var-plaintext`,
    // `data: secret`) : the answer is the point. Without it, the risk is the
    // keys only, and `plain` vars would come back in clear : redact.
    if (args.decrypt === true) {
      query.decrypt = 'true';
      return callRest(call, 'GET', `/v10/projects/${project}/env`, query, null);
    }
    return redactEncryptedEnvListing(
      await callRest(call, 'GET', `/v10/projects/${project}/env`, query, null),
    );
  }
  if (tool === DELETE_ENV_VAR) {
    if (args.id === undefined) {
      throw new ExecutorRefusal(`Vercel custom tool ${tool}: id is required.`);
    }
    const envVarId = pathIdent(args.id);
    if (envVarId === null) throw new ExecutorRefusal(MALFORMED_ENV_VAR_ID);
    return callRest(call, 'DELETE', `/v9/projects/${project}/env/${envVarId}`, query, null);
  }
  if (tool === LIST_DOMAINS) {
    return callRest(call, 'GET', `/v9/projects/${project}/domains`, query, null);
  }
  if (tool === ADD_DOMAIN) {
    if (args.name === undefined) {
      throw new ExecutorRefusal(`Vercel custom tool ${tool}: name is required.`);
    }
    if (domainName(args.name) === null) throw new ExecutorRefusal(MALFORMED_DOMAIN_NAME);
    const body = pickDefined(args, ADD_DOMAIN_FIELDS);
    return callRest(call, 'POST', `/v10/projects/${project}/domains`, query, body);
  }
  if (tool === VERIFY_DOMAIN || tool === REMOVE_DOMAIN) {
    if (args.domain === undefined) {
      throw new ExecutorRefusal(`Vercel custom tool ${tool}: domain is required.`);
    }
    // A domain is dotted : `domainName` rules out dot-only values and
    // separators, which is what keeps it one path segment ; every character
    // of the grammar (`*` of a wildcard domain included) is literal in a path.
    const domain = domainName(args.domain);
    if (domain === null) throw new ExecutorRefusal(MALFORMED_DOMAIN);
    const path = `/v9/projects/${project}/domains/${domain}`;
    return tool === VERIFY_DOMAIN
      ? callRest(call, 'POST', `${path}/verify`, query, {})
      : callRest(call, 'DELETE', path, query, null);
  }

  // ─── Firewall / WAF tools ───────────────────────────────────────────────

  if (tool === GET_FIREWALL_CONFIG) {
    query.projectId = project;
    return callRest(call, 'GET', '/v1/security/firewall/config/active', query, null);
  }
  if (tool === TOGGLE_FIREWALL) {
    if (typeof args.enabled !== 'boolean') {
      throw new ExecutorRefusal(`Vercel custom tool ${tool}: enabled (boolean) is required.`);
    }
    query.projectId = project;
    return callRest(call, 'PATCH', '/v1/security/firewall/config', query, {
      action: 'firewallEnabled',
      value: args.enabled,
    });
  }
  if (tool === UPSERT_FIREWALL_RULE) {
    if (typeof args.name !== 'string') {
      throw new ExecutorRefusal(`Vercel custom tool ${tool}: name is required.`);
    }
    query.projectId = project;
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
    if (!ruleId) throw new ExecutorRefusal(`Vercel custom tool ${tool}: ruleId is required.`);
    query.projectId = project;
    return callRest(call, 'PATCH', '/v1/security/firewall/config', query, {
      action: 'rules.remove',
      id: ruleId,
    });
  }
  if (tool === MANAGE_IP_BLOCKING) {
    const operation = typeof args.operation === 'string' ? args.operation : '';
    if (operation !== 'insert' && operation !== 'remove') {
      throw new ExecutorRefusal(
        `Vercel custom tool ${tool}: operation must be 'insert' or 'remove'.`,
      );
    }
    query.projectId = project;
    if (operation === 'insert') {
      if (typeof args.ip !== 'string' || !args.ip) {
        throw new ExecutorRefusal(`Vercel custom tool ${tool}: ip is required for insert.`);
      }
      const value = pickDefined(args, ['hostname', 'ip', 'action', 'notes']);
      return callRest(call, 'PATCH', '/v1/security/firewall/config', query, {
        action: 'ip.insert',
        value,
      });
    }
    const ipRuleId = typeof args.id === 'string' ? args.id : '';
    if (!ipRuleId) {
      throw new ExecutorRefusal(`Vercel custom tool ${tool}: id is required for remove.`);
    }
    return callRest(call, 'PATCH', '/v1/security/firewall/config', query, {
      action: 'ip.remove',
      id: ipRuleId,
    });
  }

  throw new ExecutorRefusal(`Vercel custom tool not implemented: ${tool}`);
}
