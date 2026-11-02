/**
 * Upstream calls of the `vercel` provider, and resource discovery.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 (the credential arrives decrypted
 *        in the context, is used for one call, never returned), §5.
 * ADR  : docs/decisions/rewrap-official-mcps.md (`tools/call` forward to
 *        https://mcp.vercel.com/, custom tools on https://api.vercel.com).
 *
 * Two upstream surfaces, one bearer :
 *   - the 18 rewrapped tools are one `tools/call` to the official Vercel MCP
 *     server through the SDK's client (`callUpstreamTool`) ; Vercel's tool
 *     result is passed through, its own `isError` included ;
 *   - the 14 custom tools hit the REST API directly (`httpJson`).
 *
 * Rules :
 *   - `fetch` and the signal come from the context, never from the global ;
 *   - a provider failure is **thrown**, never returned : 401 / 403 from
 *     either surface → `UpstreamAuthError` (the host marks the connection
 *     `expired` on a 401), any other failed status → `UpstreamHttpError`, a
 *     JSON-RPC error frame, an answer that is not JSON or not of the
 *     expected shape → `UpstreamProtocolError`, a network failure → the error
 *     itself. The host records it as `upstream_error` in the audit ;
 *   - what this executor declines itself (an argument it cannot read, a
 *     target outside the mission, a deployment it could not bind) is an
 *     `ExecutorRefusal`, which `declining` returns as an `isError` result ;
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
  ExecutorRefusal,
  UpstreamAuthError,
  UpstreamHttpError,
  anyJson,
  callUpstreamTool,
  declining,
  httpJson,
  isList,
  isRecord,
  jsonResult,
  type ConnectionContext,
  type ExecuteContext,
  type Guard,
  type McpToolResult,
  type Resource,
  type UpstreamIo,
} from '@vaubaan/plugin-sdk';

import {
  domainName,
  isAccountTool,
  isClassifiedTool,
  MALFORMED_DOMAIN,
  MALFORMED_DOMAIN_NAME,
  MALFORMED_ENV_VAR_ID,
  pathIdent,
  readDeploymentTargets,
  resolveProject,
  unboundToolDenial,
  UNBOUND_TOOLS,
  undeclaredArgument,
  VERCEL_ENVS,
} from './classify.ts';
import { vercelAuth } from './credential.ts';
import { PROVIDER_ID, TOOL, VERCEL_API_BASE, VERCEL_MCP_SERVER } from './identity.ts';
import { PROJECT_TOOLS, redactProjectResult } from './project-redact.ts';
import { redactEncryptedEnvListing } from './redact.ts';
import { isCustomTool, toUpstreamName, toolAcceptsArgument, vercelToolByName } from './tools.ts';

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
  [TOOL.searchVercelDocumentation]:
    'Public documentation search : the answer does not depend on a team and reads no team data.',
  [TOOL.checkDomainAvailabilityAndPrice]:
    'Registrar lookup of public availability and price : reads no team data.',
  [TOOL.getAccessToVercelUrl]:
    'Addressed by URL : the deployment is first resolved through the REST API under the pinned team and must belong to the mission project.',
  [TOOL.webFetchVercelUrl]:
    'Addressed by URL : the deployment is first resolved through the REST API under the pinned team and must belong to the mission project.',
};

/** Lookup answers that mean "this team cannot see that deployment". */
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

/** What one upstream call needs : the context's `fetch` and signal, and the credential. */
interface VercelCall {
  readonly io: UpstreamIo;
  readonly token: string;
  /** The connection's team. */
  readonly teamId: string;
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
  const call: VercelCall = { io: ctx, token, teamId };
  return declining(async () => {
    const pinned = pinArgs(tool, args, teamId, ctx.resources);
    const finalArgs = await bindDeployments(call, tool, pinned.args, pinned.projectRef);
    const result = isCustomTool(tool)
      ? jsonResult(await executeCustom(call, tool, finalArgs))
      : await callUpstreamTool(ctx, VERCEL_MCP_SERVER, token, toUpstreamName(tool), finalArgs);
    // A project object carries env values and deploy-hook URLs (`project-redact.ts`).
    return PROJECT_TOOLS.has(tool) ? redactProjectResult(result) : result;
  });
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
  const call: VercelCall = { io: ctx, token, teamId };

  const team = await readTeam(call, teamId);

  const projects: Project[] = [];
  let until: number | undefined;
  for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
    const query: Record<string, string> = { teamId, limit: String(DISCOVERY_PAGE_SIZE) };
    if (until !== undefined) query.until = String(until);
    const answer = await rest(call, 'GET', '/v10/projects', query, isProjectPage);
    const batch = isList(answer) ? answer : (answer.projects ?? []);
    projects.push(...batch);
    const next = isList(answer) ? null : (answer.pagination?.next ?? null);
    if (next === null || batch.length === 0) break;
    until = next;
  }

  // A ref the classifier would refuse is of no use to a mission : say so at
  // connection time instead of listing a resource no call can name.
  const unusable = projects.find((p) => pathIdent(p.id) === null);
  if (unusable) {
    throw new Error(
      `${PROVIDER_ID}: project id ${JSON.stringify(unusable.id)} is not a path-safe identifier`,
    );
  }

  return projects.map((p) => ({
    provider: PROVIDER_ID,
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

/** What discovery keeps of the team ; each field only when Vercel gives it as a string. */
interface Team {
  readonly id?: string;
  readonly slug?: string;
  readonly name?: string;
}

/** The team, or nothing when the token may not read it (a token scoped to projects). */
async function readTeam(call: VercelCall, teamId: string): Promise<Team> {
  let answer: Readonly<Record<string, unknown>>;
  try {
    answer = await rest(call, 'GET', `/v2/teams/${encodeURIComponent(teamId)}`, {}, isRecord);
  } catch (e) {
    if (e instanceof UpstreamAuthError && e.upstreamStatus === HTTP_FORBIDDEN) return {};
    throw e;
  }
  const team: { id?: string; slug?: string; name?: string } = {};
  for (const field of ['id', 'slug', 'name'] as const) {
    const value = answer[field];
    if (typeof value === 'string') team[field] = value;
  }
  return team;
}

/** One project of `GET /v10/projects`, as discovery reads it. */
interface Project {
  readonly id: string;
  readonly name: string;
  readonly framework?: string | null;
}

function isProject(value: unknown): value is Project {
  if (!isRecord(value)) return false;
  const { id, name, framework } = value;
  return (
    typeof id === 'string' &&
    typeof name === 'string' &&
    (framework === undefined || framework === null || typeof framework === 'string')
  );
}

/** `GET /v10/projects` : a bare list, or `{ projects, pagination: { next } }`. */
type ProjectPage =
  | readonly Project[]
  | {
      readonly projects?: readonly Project[];
      readonly pagination?: { readonly next?: number | null };
    };

function isProjectPage(value: unknown): value is ProjectPage {
  if (isList(value)) return value.every(isProject);
  if (!isRecord(value)) return false;
  const { projects, pagination } = value;
  if (projects !== undefined && !(isList(projects) && projects.every(isProject))) return false;
  if (pagination === undefined) return true;
  if (!isRecord(pagination)) return false;
  const { next } = pagination;
  return next === undefined || next === null || typeof next === 'number';
}

interface PinnedArgs {
  readonly args: Record<string, unknown>;
  readonly projectRef: string | null;
}

/**
 * Write the two arguments the mission leaves no choice over — the team of the
 * credential and the project the classifier resolved — and refuse what cannot
 * be pinned (`ExecutorRefusal`). No network call.
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
  if (UNBOUND_TOOLS.has(tool)) throw new ExecutorRefusal(unboundToolDenial(tool));
  if (!isClassifiedTool(tool) || vercelToolByName(tool) === undefined) {
    throw new ExecutorRefusal(`unknown vercel tool '${tool}'.`);
  }
  if (args.teamId !== undefined && args.teamId !== teamId) {
    throw new ExecutorRefusal(
      `teamId is fixed by the connection ('${teamId}') : the value given is not the team of this connection — omit the argument.`,
    );
  }
  const project = resolveProject(args, resources, !isAccountTool(tool));
  if ('denied' in project) throw new ExecutorRefusal(project.denied);
  // Everything else is forwarded as given : only what the tool declares may be there.
  const undeclared = undeclaredArgument(tool, args);
  if (undeclared !== null) throw new ExecutorRefusal(undeclared);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'teamId' && key !== 'projectId') out[key] = value;
  }
  if (toolAcceptsArgument(tool, 'teamId')) {
    out.teamId = teamId;
  } else if (!Object.hasOwn(TEAMLESS_UPSTREAM_TOOLS, tool)) {
    throw new ExecutorRefusal(
      `${tool}: the upstream tool cannot carry the team of this connection and has not been reviewed — refused.`,
    );
  }
  if (project.ref !== null && !isAccountTool(tool) && toolAcceptsArgument(tool, 'projectId')) {
    out.projectId = project.ref;
  }
  return { args: out, projectRef: project.ref };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deployment binding : the deployment a call names belongs to the mission project
// ─────────────────────────────────────────────────────────────────────────────

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
    // Read field by field below : a lookup that does not name its project is a refusal.
    body = await rest(
      call,
      'GET',
      `/v13/deployments/${encodeURIComponent(key)}`,
      { teamId: call.teamId },
      anyJson,
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

// ─────────────────────────────────────────────────────────────────────────────
// REST API (custom tools, discovery)
// ─────────────────────────────────────────────────────────────────────────────

type RestMethod = 'GET' | 'PATCH' | 'POST' | 'DELETE';

/** One request to the REST API under the connection's bearer, its answer read through `guard`. */
async function rest<T>(
  call: VercelCall,
  method: RestMethod,
  path: string,
  query: Readonly<Record<string, string>>,
  guard: Guard<T>,
  body?: Readonly<Record<string, unknown>>,
): Promise<T> {
  const qs = new URLSearchParams(query).toString();
  return httpJson(
    call.io,
    {
      url: `${VERCEL_API_BASE}${path}${qs ? `?${qs}` : ''}`,
      method,
      headers: { authorization: `Bearer ${call.token}` },
      ...(body !== undefined ? { body } : {}),
    },
    guard,
  );
}

/**
 * A custom tool's request : Vercel's answer is shown to the agent as it is.
 * An answer without content (a `DELETE`, a 204) has always read `{}`.
 */
async function customRest(
  call: VercelCall,
  method: RestMethod,
  path: string,
  query: Readonly<Record<string, string>>,
  body?: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return (await rest(call, method, path, query, anyJson, body)) ?? {};
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

  if (tool === TOOL.updateProjectSettings) {
    const body = pickDefined(args, PROJECT_SETTINGS_FIELDS);
    return customRest(call, 'PATCH', `/v9/projects/${project}`, query, body);
  }
  if (tool === TOOL.disconnectGit) {
    // Vercel answers with the project object (env values, deploy-hook URLs) :
    // it is read, then dropped, never shown to the agent.
    await customRest(call, 'DELETE', `/v9/projects/${project}/link`, query);
    return { ok: true, projectId: project };
  }
  if (tool === TOOL.upsertEnvVar) {
    query.upsert = 'true';
    const body = pickDefined(args, ENV_VAR_FIELDS);
    return customRest(call, 'POST', `/v10/projects/${project}/env`, query, body);
  }
  if (tool === TOOL.listEnvVars) {
    // `decrypt=true` is the plaintext read (`read-env-var-plaintext`,
    // `data: secret`) : the answer is the point. Without it, the risk is the
    // keys only, and `plain` vars would come back in clear : redact.
    if (args.decrypt === true) {
      query.decrypt = 'true';
      return customRest(call, 'GET', `/v10/projects/${project}/env`, query);
    }
    return redactEncryptedEnvListing(
      await customRest(call, 'GET', `/v10/projects/${project}/env`, query),
    );
  }
  if (tool === TOOL.deleteEnvVar) {
    if (args.id === undefined) {
      throw new ExecutorRefusal(`Vercel custom tool ${tool}: id is required.`);
    }
    const envVarId = pathIdent(args.id);
    if (envVarId === null) throw new ExecutorRefusal(MALFORMED_ENV_VAR_ID);
    return customRest(call, 'DELETE', `/v9/projects/${project}/env/${envVarId}`, query);
  }
  if (tool === TOOL.listProjectDomains) {
    return customRest(call, 'GET', `/v9/projects/${project}/domains`, query);
  }
  if (tool === TOOL.addProjectDomain) {
    if (args.name === undefined) {
      throw new ExecutorRefusal(`Vercel custom tool ${tool}: name is required.`);
    }
    if (domainName(args.name) === null) throw new ExecutorRefusal(MALFORMED_DOMAIN_NAME);
    const body = pickDefined(args, ADD_DOMAIN_FIELDS);
    return customRest(call, 'POST', `/v10/projects/${project}/domains`, query, body);
  }
  if (tool === TOOL.verifyProjectDomain || tool === TOOL.removeProjectDomain) {
    if (args.domain === undefined) {
      throw new ExecutorRefusal(`Vercel custom tool ${tool}: domain is required.`);
    }
    // A domain is dotted : `domainName` rules out dot-only values and
    // separators, which is what keeps it one path segment ; every character
    // of the grammar (`*` of a wildcard domain included) is literal in a path.
    const domain = domainName(args.domain);
    if (domain === null) throw new ExecutorRefusal(MALFORMED_DOMAIN);
    const path = `/v9/projects/${project}/domains/${domain}`;
    return tool === TOOL.verifyProjectDomain
      ? customRest(call, 'POST', `${path}/verify`, query, {})
      : customRest(call, 'DELETE', path, query);
  }

  // ─── Firewall / WAF tools ───────────────────────────────────────────────

  if (tool === TOOL.getFirewallConfig) {
    query.projectId = project;
    return customRest(call, 'GET', '/v1/security/firewall/config/active', query);
  }
  if (tool === TOOL.toggleFirewall) {
    if (typeof args.enabled !== 'boolean') {
      throw new ExecutorRefusal(`Vercel custom tool ${tool}: enabled (boolean) is required.`);
    }
    query.projectId = project;
    return customRest(call, 'PATCH', '/v1/security/firewall/config', query, {
      action: 'firewallEnabled',
      value: args.enabled,
    });
  }
  if (tool === TOOL.upsertFirewallRule) {
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
    return customRest(call, 'PATCH', '/v1/security/firewall/config', query, body);
  }
  if (tool === TOOL.removeFirewallRule) {
    const ruleId = typeof args.ruleId === 'string' ? args.ruleId : '';
    if (!ruleId) throw new ExecutorRefusal(`Vercel custom tool ${tool}: ruleId is required.`);
    query.projectId = project;
    return customRest(call, 'PATCH', '/v1/security/firewall/config', query, {
      action: 'rules.remove',
      id: ruleId,
    });
  }
  if (tool === TOOL.manageIpBlocking) {
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
      return customRest(call, 'PATCH', '/v1/security/firewall/config', query, {
        action: 'ip.insert',
        value,
      });
    }
    const ipRuleId = typeof args.id === 'string' ? args.id : '';
    if (!ipRuleId) {
      throw new ExecutorRefusal(`Vercel custom tool ${tool}: id is required for remove.`);
    }
    return customRest(call, 'PATCH', '/v1/security/firewall/config', query, {
      action: 'ip.remove',
      id: ipRuleId,
    });
  }

  throw new ExecutorRefusal(`Vercel custom tool not implemented: ${tool}`);
}
