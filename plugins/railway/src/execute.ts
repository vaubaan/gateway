/**
 * Upstream calls of the `railway` provider.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *        decrypted in the context, is used for one call, and never reaches
 *        the executor.
 * ADR  : docs/decisions/railway-rewrap-remote-mcp.md.
 *
 * Two upstreams :
 *   - the official Railway MCP server, https://mcp.railway.com/ (Streamable
 *     HTTP, SSE-framed JSON-RPC, stateless per Bearer : no `Mcp-Session-Id`,
 *     no `initialize` before `tools/call`). Our `tools/call` is forwarded
 *     with the `railway__` prefix stripped ;
 *   - the public GraphQL API, https://backboard.railway.com/graphql/v2, for
 *     the four variable tools and for resource discovery.
 *
 * Rules : `fetch` comes from the context (tests inject `mockFetch`) ;
 * 401 / 403 → `UpstreamAuthError` so the host can refresh and retry ; the
 * API bases are facts about the provider, not instance configuration.
 *
 * The lower layer (`callUpstream`, `callGraphql`, `executeCall`) takes a
 * bare `fetch` + token and is shared with the legacy v4 adapter
 * (`railway-adapter.ts`, deleted in P1.6).
 */

import {
  UpstreamAuthError,
  expectCredentialKind,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolContent,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { PROVIDER } from './classify.ts';
import {
  CUSTOM_TOOL_NAMES,
  DELETE_VARIABLE,
  LIST_VARIABLES,
  UPSERT_VARIABLE,
  UPSERT_VARIABLES,
} from './custom-tools.ts';
import { railwayTools, toUpstreamName } from './tools.ts';

export type FetchImpl = typeof fetch;

export const RAILWAY_MCP_URL = 'https://mcp.railway.com/';
export const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';
/** Projects fetched per GraphQL page during discovery. */
export const RAILWAY_PROJECT_PAGE_SIZE = 100;
/** Hard stop on discovery paging : 5 × 100 projects is far beyond any single workspace. */
export const RAILWAY_MAX_PROJECT_PAGES = 5;

const AGENT_TOOL = 'railway__railway-agent';

/** Appended to every `railway-agent` answer : the agent stages, `accept-deploy` commits. */
export const RAILWAY_AGENT_HINT =
  'Vaubaan hint: the railway-agent stages configuration changes (repo source, Dockerfile, build settings, etc.) ' +
  'but does NOT commit or deploy them. If the agent reports that changes were made or a ' +
  '"deployment was triggered", the changes are only staged. Call railway__accept-deploy ' +
  'with the environmentId to commit the staged changes and trigger the actual deployment.';

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC over Streamable HTTP
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
 * Extract the first JSON-RPC frame whose id matches (or is null) from a
 * Streamable HTTP body : SSE `data:` lines, or a bare JSON document.
 */
export function parseFirstJsonRpcFrame(body: string, id: number): JsonRpcResponse {
  const candidates: string[] = [];
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) candidates.push(trimmed);
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) candidates.push(line.slice('data:'.length).trim());
  }
  for (const payload of candidates) {
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
  throw new Error(`No JSON-RPC frame matched id ${id} in the Railway MCP response.`);
}

export async function callUpstream(
  fetchImpl: FetchImpl,
  token: string,
  method: string,
  params: Record<string, unknown> | undefined,
  options: { readonly signal?: AbortSignal; readonly id?: number } = {},
): Promise<unknown> {
  const id = options.id ?? Math.floor(Math.random() * 1_000_000_000);
  const res = await fetchImpl(RAILWAY_MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) {
    const errText = await res.text();
    const msg = `Railway MCP upstream ${res.status}: ${errText.slice(0, 300)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(msg, res.status);
    throw new Error(msg);
  }
  const frame = parseFirstJsonRpcFrame(await res.text(), id);
  if ('error' in frame) {
    throw new Error(`Railway MCP upstream error ${frame.error.code}: ${frame.error.message}`);
  }
  return frame.result;
}

/**
 * Run one tool with a bare token : MCP forward for upstream tools, GraphQL
 * for the custom variable tools. Returns the raw upstream result.
 */
export async function executeCall(
  fetchImpl: FetchImpl,
  token: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (CUSTOM_TOOL_NAMES.has(tool)) return executeCustom(fetchImpl, token, tool, args, signal);
  return callUpstream(
    fetchImpl,
    token,
    'tools/call',
    { name: toUpstreamName(tool), arguments: args },
    { signal },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL
// ─────────────────────────────────────────────────────────────────────────────

export async function callGraphql<T>(
  fetchImpl: FetchImpl,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetchImpl(RAILWAY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const errText = await res.text();
    const msg = `Railway GraphQL ${res.status}: ${errText.slice(0, 300)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(msg, res.status);
    throw new Error(msg);
  }
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Railway GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body.data) throw new Error('Railway GraphQL: empty data response.');
  return body.data;
}

async function executeCustom(
  fetchImpl: FetchImpl,
  token: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (tool) {
    case LIST_VARIABLES: {
      const data = await callGraphql<{ variables: Record<string, string> }>(
        fetchImpl,
        token,
        /* GraphQL */ `
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
        {
          projectId: args.projectId,
          environmentId: args.environmentId,
          serviceId: args.serviceId ?? null,
          unrendered: args.unrendered ?? false,
        },
        signal,
      );
      return data.variables;
    }
    case UPSERT_VARIABLE: {
      const data = await callGraphql<{ variableUpsert: boolean }>(
        fetchImpl,
        token,
        /* GraphQL */ `
          mutation variableUpsert($input: VariableUpsertInput!) {
            variableUpsert(input: $input)
          }
        `,
        {
          input: stripUndefined({
            projectId: args.projectId,
            environmentId: args.environmentId,
            serviceId: args.serviceId,
            name: args.name,
            value: args.value,
            skipDeploys: args.skipDeploys,
          }),
        },
        signal,
      );
      return { ok: data.variableUpsert === true };
    }
    case UPSERT_VARIABLES: {
      const data = await callGraphql<{ variableCollectionUpsert: boolean }>(
        fetchImpl,
        token,
        /* GraphQL */ `
          mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
            variableCollectionUpsert(input: $input)
          }
        `,
        {
          input: stripUndefined({
            projectId: args.projectId,
            environmentId: args.environmentId,
            serviceId: args.serviceId,
            variables: args.variables,
            replace: args.replace,
            skipDeploys: args.skipDeploys,
          }),
        },
        signal,
      );
      return { ok: data.variableCollectionUpsert === true };
    }
    case DELETE_VARIABLE: {
      const data = await callGraphql<{ variableDelete: boolean }>(
        fetchImpl,
        token,
        /* GraphQL */ `
          mutation variableDelete($input: VariableDeleteInput!) {
            variableDelete(input: $input)
          }
        `,
        {
          input: stripUndefined({
            projectId: args.projectId,
            environmentId: args.environmentId,
            serviceId: args.serviceId,
            name: args.name,
          }),
        },
        signal,
      );
      return { ok: data.variableDelete === true };
    }
    default:
      throw new Error(`Unknown Railway custom tool: ${tool}`);
  }
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// v5 contract : execute(ctx, tool, args) and discoverResources(ctx)
// ─────────────────────────────────────────────────────────────────────────────

const DECLARED_TOOLS: ReadonlySet<string> = new Set(railwayTools.map((t) => t.name));

/** Tools whose input schema declares a `projectId` : the single mission project fills it when absent. */
const TOOLS_TAKING_PROJECT_ID: ReadonlySet<string> = new Set(
  railwayTools.filter((t) => 'projectId' in (t.inputSchema.properties ?? {})).map((t) => t.name),
);

export async function executeRailway(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  if (!DECLARED_TOOLS.has(tool)) {
    return { content: [{ type: 'text', text: `unknown tool '${tool}'` }], isError: true };
  }
  const secret = expectCredentialKind(PROVIDER, ctx.credential, 'oauth2');
  const effective = withDefaultProject(tool, args, ctx.resources);
  const result = await executeCall(ctx.fetch, secret.accessToken, tool, effective, ctx.signal);

  const mcp = asToolResult(result);
  if (tool === AGENT_TOOL) {
    return { ...mcp, content: [...mcp.content, { type: 'text', text: RAILWAY_AGENT_HINT }] };
  }
  return mcp;
}

/**
 * Resources reachable with this credential : one `Resource` per Railway
 * project, its environments (`{ id, name }`) in `metadata.environments` so
 * the owner can label the project and the classifier can resolve
 * `environmentId` back to a project.
 */
export async function discoverRailwayResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const secret = expectCredentialKind(PROVIDER, ctx.credential, 'oauth2');
  const out: Resource[] = [];
  let after: string | null = null;
  for (let page = 0; page < RAILWAY_MAX_PROJECT_PAGES; page += 1) {
    const data: ProjectsPage = await callGraphql<ProjectsPage>(
      ctx.fetch,
      secret.accessToken,
      PROJECTS_QUERY,
      { first: RAILWAY_PROJECT_PAGE_SIZE, after },
      ctx.signal,
    );
    for (const edge of data.projects.edges) {
      const node = edge.node;
      out.push({
        provider: PROVIDER,
        ref: node.id,
        displayName: node.name,
        metadata: {
          environments: (node.environments?.edges ?? []).map((e) => ({
            id: e.node.id,
            name: e.node.name,
          })),
        },
      });
    }
    if (!data.projects.pageInfo?.hasNextPage || !data.projects.pageInfo.endCursor) break;
    after = data.projects.pageInfo.endCursor;
  }
  return out;
}

const PROJECTS_QUERY = /* GraphQL */ `
  query vaubaanProjects($first: Int!, $after: String) {
    projects(first: $first, after: $after) {
      edges {
        node {
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
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface ProjectsPage {
  readonly projects: {
    readonly edges: ReadonlyArray<{
      readonly node: {
        readonly id: string;
        readonly name: string;
        readonly environments?: {
          readonly edges: ReadonlyArray<{ readonly node: { id: string; name: string } }>;
        } | null;
      };
    }>;
    readonly pageInfo?: { readonly hasNextPage: boolean; readonly endCursor: string | null } | null;
  };
}

function withDefaultProject(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): Readonly<Record<string, unknown>> {
  if (!TOOLS_TAKING_PROJECT_ID.has(tool) || args.projectId !== undefined) return args;
  const own = resources.filter((r) => r.provider === PROVIDER);
  if (own.length !== 1) {
    throw new Error(
      'projectId: argument required when the mission touches several Railway projects',
    );
  }
  return { ...args, projectId: own[0]!.ref };
}

/** The MCP server answers `tools/call` with an MCP result ; GraphQL tools answer with plain data. */
function asToolResult(result: unknown): McpToolResult {
  if (
    typeof result === 'object' &&
    result !== null &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    const r = result as { content: McpToolContent[]; isError?: boolean };
    return r.isError === undefined
      ? { content: r.content }
      : { content: r.content, isError: r.isError };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
