/**
 * Upstream calls of the `railway` service.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *        decrypted in the context, is used for one call, and never reaches
 *        the executor.
 * ADR  : docs/decisions/rewrap-official-mcps.md.
 *
 * Two upstreams :
 *   - the official Railway MCP server, https://mcp.railway.com/ (Streamable
 *     HTTP, SSE-framed JSON-RPC, stateless per Bearer : no `Mcp-Session-Id`,
 *     no `initialize` before `tools/call`). Our `tools/call` is forwarded
 *     with the `railway__` prefix stripped ;
 *   - the public GraphQL API, https://backboard.railway.com/graphql/v2, for
 *     the four variable tools and for resource discovery.
 *
 * `list-projects` reaches neither : it answers the mission's projects from
 * the resources the gateway passes (`missionProjects`).
 *
 * Rules : `fetch` comes from the context (tests inject `mockFetch`) ;
 * 401 / 403 → `UpstreamAuthError` so the host can refresh and retry ; the
 * API bases are facts about the service, not instance configuration.
 *
 * A project-scoped call is resolved by the classifier's own `resolveTarget`
 * and `readVariableWrite` : the project, environment, service and deployment
 * ids of the request are written from their answer, never copied from the
 * arguments, so the call runs on what the slices named or not at all. No id
 * reaches a URL : the rewrapped tools carry them as JSON-RPC arguments, the
 * variable tools as GraphQL variables of a constant document.
 *
 * Failures, all typed : what the plugin declines (an unknown tool, an
 * undeclared argument, a target the mission cannot resolve) is an `isError`
 * result before any request (`refusalResult`, `ExecutorRefusal` inside
 * `declining`) ; what Railway fails is thrown — 401 / 403
 * `UpstreamAuthError`, another failed status `UpstreamHttpError`, a JSON-RPC
 * error frame, GraphQL `errors` or an answer of the wrong shape
 * `UpstreamProtocolError` (`graphql.ts`, the SDK's MCP client).
 */

import {
  ExecutorRefusal,
  UpstreamAuthError,
  UpstreamProtocolError,
  callUpstreamTool,
  declining,
  isList,
  isRecord,
  jsonResult,
  refusalResult,
  type AccountContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import {
  environmentsOf,
  isProjectScopedTool,
  servicesOf,
  type RailwayEnvironmentRef,
  type RailwayServiceRef,
  railwayId,
  readVariableWrite,
  resolveTarget,
  undeclaredArgument,
} from './classify.ts';
import { CUSTOM_TOOL_NAMES } from './custom-tools.ts';
import { explainMcpRefusal, railwayBearerOf } from './credential.ts';
import { askRailwayGraphql, nodesOf, railwayGraphql, type GraphqlRequest } from './graphql.ts';
import { SERVICE_ID, RAILWAY_MCP_SERVER, TOOL } from './identity.ts';
import { forwardTakesProjectId, railwayTools, toUpstreamName } from './tools.ts';

/** Projects fetched per GraphQL page during discovery. */
export const RAILWAY_PROJECT_PAGE_SIZE = 100;
/** Hard stop on discovery paging : 5 × 100 projects is far beyond any single workspace. */
export const RAILWAY_MAX_PROJECT_PAGES = 5;

/** Appended to every `railway-agent` answer : the agent stages, `accept-deploy` commits. */
export const RAILWAY_AGENT_HINT =
  'Vaubaan hint: the railway-agent stages configuration changes (repo source, Dockerfile, build settings, etc.) ' +
  'but does NOT commit or deploy them. If the agent reports that changes were made or a ' +
  `"deployment was triggered", the changes are only staged. Call ${TOOL.acceptDeploy} ` +
  'with the environmentId to commit the staged changes and trigger the actual deployment.';

// ─────────────────────────────────────────────────────────────────────────────
// The variable tools, over GraphQL
// ─────────────────────────────────────────────────────────────────────────────

/** `variables(...)` answers an object mapping each name to its value. */
function isVariablesAnswer(x: unknown): x is { readonly variables: Record<string, unknown> } {
  return isRecord(x) && isRecord(x.variables);
}

/** A mutation of the variable tools answers one Boolean under its own field. */
function isBooleanAnswer(field: string) {
  return (x: unknown): x is Readonly<Record<string, boolean>> =>
    isRecord(x) && typeof x[field] === 'boolean';
}

/** One boolean mutation, its answer as `{ ok }`. */
async function mutate(
  ctx: ExecuteContext,
  token: string,
  request: GraphqlRequest,
): Promise<{ readonly ok: boolean }> {
  const data = await railwayGraphql(ctx, token, request, isBooleanAnswer(request.operation));
  return { ok: data[request.operation] === true };
}

/** The variable tool `tool`, run with the arguments `pinTarget` wrote ; the data Railway answered. */
async function executeVariableTool(
  ctx: ExecuteContext,
  token: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  switch (tool) {
    case TOOL.listVariables: {
      const data = await railwayGraphql(
        ctx,
        token,
        {
          operation: 'variables',
          query: /* GraphQL */ `
            query variables(
              $projectId: String!
              $environmentId: String!
              $serviceId: String
              $unrendered: Boolean
            ) {
              variables(
                projectId: $projectId
                environmentId: $environmentId
                serviceId: $serviceId
                unrendered: $unrendered
              )
            }
          `,
          variables: {
            projectId: args.projectId,
            environmentId: args.environmentId,
            serviceId: args.serviceId ?? null,
            unrendered: args.unrendered ?? false,
          },
        },
        isVariablesAnswer,
      );
      return data.variables;
    }
    case TOOL.upsertVariable:
      return mutate(ctx, token, {
        operation: 'variableUpsert',
        query: /* GraphQL */ `
          mutation variableUpsert($input: VariableUpsertInput!) {
            variableUpsert(input: $input)
          }
        `,
        variables: {
          input: stripUndefined({
            projectId: args.projectId,
            environmentId: args.environmentId,
            serviceId: args.serviceId,
            name: args.name,
            value: args.value,
            skipDeploys: args.skipDeploys,
          }),
        },
      });
    case TOOL.upsertVariables:
      return mutate(ctx, token, {
        operation: 'variableCollectionUpsert',
        query: /* GraphQL */ `
          mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
            variableCollectionUpsert(input: $input)
          }
        `,
        variables: {
          input: stripUndefined({
            projectId: args.projectId,
            environmentId: args.environmentId,
            serviceId: args.serviceId,
            variables: args.variables,
            replace: args.replace,
            skipDeploys: args.skipDeploys,
          }),
        },
      });
    case TOOL.deleteVariable:
      return mutate(ctx, token, {
        operation: 'variableDelete',
        query: /* GraphQL */ `
          mutation variableDelete($input: VariableDeleteInput!) {
            variableDelete(input: $input)
          }
        `,
        variables: {
          input: stripUndefined({
            projectId: args.projectId,
            environmentId: args.environmentId,
            serviceId: args.serviceId,
            name: args.name,
          }),
        },
      });
    default:
      // `CUSTOM_TOOL_NAMES` routes only the four above here : a fifth one
      // declared without its case is declined, never sent.
      throw new ExecutorRefusal(`unknown tool '${tool}'`);
  }
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin contract : execute(ctx, tool, args) and discoverResources(ctx)
// ─────────────────────────────────────────────────────────────────────────────

const DECLARED_TOOLS: ReadonlySet<string> = new Set(railwayTools.map((t) => t.name));

export async function executeRailway(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  return declining(async () => {
    if (!DECLARED_TOOLS.has(tool)) return refusalResult(`unknown tool '${tool}'`);
    const token = railwayBearerOf(ctx.credential);
    const effective = pinTarget(tool, args, ctx.resources);
    // Declined here, before any request : a result the agent reads, not an upstream failure.
    if ('refused' in effective) return refusalResult(effective.refused);
    // Answered from the mission, never forwarded : Railway's answer lists every project the token sees.
    if (tool === TOOL.listProjects) return jsonResult(missionProjects(ctx.resources));
    if (CUSTOM_TOOL_NAMES.has(tool)) {
      return jsonResult(await executeVariableTool(ctx, token, tool, effective.args));
    }
    const result = await callMcpTool(ctx, token, tool, effective.args);
    if (tool === TOOL.railwayAgent) {
      return {
        ...result,
        content: [...result.content, { type: 'text', text: RAILWAY_AGENT_HINT }],
      };
    }
    return result;
  });
}

/** One `tools/call` to Railway's MCP server, the prefix stripped ; Railway's result passed through. */
async function callMcpTool(
  ctx: ExecuteContext,
  token: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  try {
    return await callUpstreamTool(ctx, RAILWAY_MCP_SERVER, token, toUpstreamName(tool), args);
  } catch (err) {
    // The token refused by the MCP server : dead (401) or a kind the server does not take (403).
    if (err instanceof UpstreamAuthError) throw await explainMcpRefusal(ctx, token, err);
    throw err;
  }
}

/**
 * Resources reachable with this credential : one `Resource` per Railway
 * project, its environments (`{ id, name }`) in `metadata.environments` so
 * the owner can label the project and the classifier can resolve
 * `environmentId` back to a project.
 */
export async function discoverRailwayResources(ctx: AccountContext): Promise<readonly Resource[]> {
  const token = railwayBearerOf(ctx.credential);
  // The projects the token reaches (a workspace token: its workspace's ;
  // an account token: its personal ones), then, for an account token only, each
  // of its workspaces'. A workspace token has no `me` : its refusal ends the list.
  const out = await listProjects(ctx, token, PROJECTS_QUERY, {});
  const me = await askRailwayGraphql(ctx, token, WORKSPACES_REQUEST, isRecord);
  if (!me.ok) return out;
  const account = me.data.me;
  const workspaces = isRecord(account) ? nodesOf(account.workspaces) : [];
  for (const { id } of workspaces) {
    if (typeof id !== 'string') continue;
    for (const project of await listProjects(ctx, token, WORKSPACE_PROJECTS_QUERY, {
      workspaceId: id,
    })) {
      if (!out.some((known) => known.ref === project.ref)) out.push(project);
    }
  }
  return out;
}

/** Every project a projects query answers, page by page up to `RAILWAY_MAX_PROJECT_PAGES`. */
async function listProjects(
  ctx: AccountContext,
  token: string,
  query: Omit<GraphqlRequest, 'variables'>,
  variables: Readonly<Record<string, unknown>>,
): Promise<Resource[]> {
  const out: Resource[] = [];
  let after: string | null = null;
  for (let page = 0; page < RAILWAY_MAX_PROJECT_PAGES; page += 1) {
    const request = {
      ...query,
      variables: { ...variables, first: RAILWAY_PROJECT_PAGE_SIZE, after },
    };
    const data: ProjectsPage = await railwayGraphql(ctx, token, request, isProjectsPage);
    for (const { node } of data.projects.edges) {
      // A ref the classifier would refuse is of no use to a mission : say so
      // when the account is connected instead of listing a resource no call can name.
      if (railwayId(node.id) === null) {
        throw new UpstreamProtocolError(
          `Railway GraphQL ${query.operation}: project id ${JSON.stringify(node.id)} is not a Railway identifier`,
        );
      }
      out.push({
        service: SERVICE_ID,
        ref: node.id,
        displayName: node.name,
        metadata: {
          environments: namedNodesOf(node.environments),
          // What a `serviceId` is bound to (`readService`) : always a list, empty included.
          services: namedNodesOf(node.services),
        },
      });
    }
    const pageInfo = data.projects.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }
  return out;
}

/** The `{ id, name }` nodes of a GraphQL connection ; a node without both as strings is skipped. */
function namedNodesOf(connection: unknown): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const { id, name } of nodesOf(connection)) {
    if (typeof id === 'string' && typeof name === 'string') out.push({ id, name });
  }
  return out;
}

/** The fields of one project node, shared by both projects queries. */
const PROJECT_NODE_FIELDS = /* GraphQL */ `
  id
  name
  environments {
    edges {
      node {
        id
        name
      }
    }
  }
  services {
    edges {
      node {
        id
        name
      }
    }
  }
`;

/** The workspaces of the account an account token belongs to (Railway docs, "Fetch workspaces"). */
const WORKSPACES_REQUEST: GraphqlRequest = {
  operation: 'vaubaanWorkspaces',
  query: /* GraphQL */ `
    query vaubaanWorkspaces {
      me {
        workspaces {
          id
          name
        }
      }
    }
  `,
  variables: {},
};

/** The projects of one workspace (Railway docs, "List projects in a workspace"). */
const WORKSPACE_PROJECTS_QUERY = {
  operation: 'vaubaanWorkspaceProjects',
  query: /* GraphQL */ `
    query vaubaanWorkspaceProjects($workspaceId: String!, $first: Int!, $after: String) {
      projects(workspaceId: $workspaceId, first: $first, after: $after) {
        edges {
          node {
            ${PROJECT_NODE_FIELDS}
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,
};

/** The projects the token reaches. */
const PROJECTS_QUERY = {
  operation: 'vaubaanProjects',
  query: /* GraphQL */ `
    query vaubaanProjects($first: Int!, $after: String) {
      projects(first: $first, after: $after) {
        edges {
          node {
            ${PROJECT_NODE_FIELDS}
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,
};

/** A page of projects : what discovery reads of it. Environments and services are read by `namedNodesOf`. */
interface ProjectsPage {
  readonly projects: {
    readonly edges: ReadonlyArray<{
      readonly node: {
        readonly id: string;
        readonly name: string;
        readonly environments?: unknown;
        readonly services?: unknown;
      };
    }>;
    readonly pageInfo?: { readonly hasNextPage: boolean; readonly endCursor: string | null } | null;
  };
}

function isProjectsPage(x: unknown): x is ProjectsPage {
  if (!isRecord(x) || !isRecord(x.projects) || !isList(x.projects.edges)) return false;
  const { edges, pageInfo } = x.projects;
  const pageInfoOk =
    pageInfo === undefined ||
    pageInfo === null ||
    (isRecord(pageInfo) &&
      typeof pageInfo.hasNextPage === 'boolean' &&
      (pageInfo.endCursor === null || typeof pageInfo.endCursor === 'string'));
  return (
    pageInfoOk &&
    edges.every(
      (edge) =>
        isRecord(edge) &&
        isRecord(edge.node) &&
        typeof edge.node.id === 'string' &&
        typeof edge.node.name === 'string',
    )
  );
}

/** The note `list-projects` answers with : what it lists, and how to name a project. */
export const LIST_PROJECTS_NOTE =
  'The Railway projects of this mission on this account; other projects the token sees are left out. ' +
  'Name one in `projectId` by its id or its name.';

/** One project of the mission, as `list-projects` answers it. */
export interface MissionProject {
  readonly id: string;
  readonly name: string;
  readonly label: string | null;
  readonly environments: readonly RailwayEnvironmentRef[];
  readonly services: readonly RailwayServiceRef[];
}

/**
 * `list-projects` : the mission's Railway projects of this account, read from
 * the resources the gateway passes, never from Railway. Railway's answer is
 * free text listing every project the token sees ; filtering it would trust
 * its format to keep another project out. Here a project outside the mission
 * is never named, and the names listed are the names `projectId` accepts.
 */
export function missionProjects(resources: readonly Resource[]): {
  projects: MissionProject[];
  note: string;
} {
  const projects = resources
    .filter((r) => r.service === SERVICE_ID)
    .map((r) => ({
      id: r.ref,
      name: r.displayName,
      label: r.env ?? null,
      environments: environmentsOf(r),
      services: servicesOf(r) ?? [],
    }));
  return { projects, note: LIST_PROJECTS_NOTE };
}

/**
 * The arguments to send, with every id written from what the classifier's
 * own functions resolved : the project (its id, whether the caller named it by
 * id or by name or not at all), the environment, the service. A call they
 * deny is refused, and so is one that names a deployment or an agent thread,
 * which nothing can bind to the project (`undeclaredArgument`). Account-level
 * tools name no resource of the mission and declare no `projectId` : their
 * declared arguments are forwarded as received.
 *
 * Every denial is a refusal the agent reads, a call that names no project the
 * mission can resolve included : nothing was sent, so nothing failed upstream.
 */
function pinTarget(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): { readonly args: Readonly<Record<string, unknown>> } | { readonly refused: string } {
  // The arguments are forwarded as given, pinned ids aside : only what the tool declares.
  const undeclared = undeclaredArgument(tool, args);
  if (undeclared !== null) return { refused: undeclared };
  if (!isProjectScopedTool(tool)) return { args };

  const target = resolveTarget(tool, args, resources);
  if ('denied' in target) return { refused: target.denied };
  const write = readVariableWrite(tool, args);
  if (write !== null && 'denied' in write) return { refused: write.denied };

  // `projectId` is the resolved project's id — never the name the agent may have given —
  // written where the upstream schema takes one and dropped where it does not (the
  // upstream schema of `accept-deploy` is closed and has no such property).
  const { projectId: _given, ...rest } = args;
  const out: Record<string, unknown> = { ...rest };
  if (forwardTakesProjectId(tool)) out.projectId = target.project.ref;
  if (target.environmentId !== null) out.environmentId = target.environmentId;
  if (target.serviceId !== null) out.serviceId = target.serviceId;
  return { args: out };
}
