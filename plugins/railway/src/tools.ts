/**
 * MCP tools of the `railway` service — rewrap of the official Railway MCP
 * server at mcp.railway.com, plus four GraphQL-backed variable tools.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5.
 * ADR  : docs/decisions/rewrap-official-mcps.md.
 *
 * The 10 upstream tools were fetched verbatim from `mcp.railway.com
 * tools/list` on 2026-05-30 (with a Bearer scoped to
 * `resource=https://mcp.railway.com`). Names are prefixed `railway__` ; the
 * upstream names are kebab-case (`list-projects`), so the prefixed name is
 * `railway__list-projects` (`TOOL`, `identity.ts`). Input schemas are the real ones (`required[]`,
 * enums, `additionalProperties: false`) — no guesses — minus the two
 * arguments the gateway refuses (`UNBOUND_ARGUMENTS`).
 *
 * Refresh procedure : POST `tools/list` to mcp.railway.com with a Bearer
 * scoped to `resource=https://mcp.railway.com`, prefix each name with
 * `railway__`, commit `upstream-tools.json`, bump the plugin version.
 *
 * Two schemas per tool :
 *   - the **declared** one, what an agent reads (`railwayTools`) : the frozen
 *     upstream schema without the unbound arguments, and on every
 *     project-scoped tool a `projectId` that takes the project's id or name
 *     (`accept-deploy`, whose upstream schema lacks it, gains it) ;
 *   - the **forward** one, the frozen upstream schema (or a custom tool's
 *     own) : `forwardTakesProjectId` says where the resolved project id is
 *     sent, and it is dropped everywhere else.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { customTools } from './custom-tools.ts';
import { TOOL, TOOL_PREFIX } from './identity.ts';
import upstream from './upstream-tools.json' with { type: 'json' };

const upstreamTools = upstream as ReadonlyArray<McpToolDeclaration>;

/** Tools that name no project : account-level. Every other tool is project-scoped. */
export const ACCOUNT_TOOLS: ReadonlySet<string> = new Set([
  TOOL.whoami,
  TOOL.listProjects,
  TOOL.createProject,
]);

/** What an agent reads of `projectId` on every project-scoped tool. */
export const PROJECT_ID_PROPERTY = {
  type: 'string',
  description:
    `The Railway project the call acts on : its id (UUID) or its name, one of the projects of the mission ` +
    `(\`${TOOL.listProjects}\` lists them). Optional when the mission holds one Railway project ; ` +
    'required otherwise, unless an environmentId names an environment of one of them.',
} as const;

/** What `list-projects` answers in this gateway, appended to the upstream description. */
const LIST_PROJECTS_NOTE =
  'In this gateway: lists only the Railway projects of the mission (id, name, environments, services); ' +
  'the other projects of the account are left out.';

/**
 * Arguments of the upstream tools that name an object the plugin cannot bind
 * to the mission's project, with what the caller does instead. Discovery
 * stores the environments and the services of a project — no deployment, no
 * agent thread — and the OAuth token reaches every project of the workspace,
 * so such an id is **never forwarded** : the classifier and the executor
 * refuse a call that carries one, and the schema the agent reads does not
 * offer it (`withoutUnboundArguments`).
 */
export const UNBOUND_ARGUMENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [TOOL.getLogs]: {
    deploymentId:
      'Give serviceId and environmentId instead: the logs of the latest deployment of that service are read.',
  },
  [TOOL.railwayAgent]: {
    threadId: 'Every call starts a new conversation: put the context it needs in the message.',
  },
};

/** The upstream declaration without the properties `UNBOUND_ARGUMENTS` refuses. */
function withoutUnboundArguments(tool: McpToolDeclaration): McpToolDeclaration {
  const unbound = Object.hasOwn(UNBOUND_ARGUMENTS, tool.name)
    ? UNBOUND_ARGUMENTS[tool.name]
    : undefined;
  const properties = tool.inputSchema.properties;
  if (unbound === undefined || properties === undefined) return tool;
  const kept = Object.fromEntries(
    Object.entries(properties).filter(([name]) => !Object.hasOwn(unbound, name)),
  );
  // The upstream description still speaks of the argument : say what the gateway does with it.
  const notes = Object.entries(unbound).map(
    ([name, instead]) => `This gateway does not accept ${name}. ${instead}`,
  );
  return {
    ...tool,
    description: [tool.description, ...notes].join(' '),
    inputSchema: { ...tool.inputSchema, properties: kept },
  };
}

/** The declared schema (see the module comment) : the project named by id or name. */
function declared(tool: McpToolDeclaration): McpToolDeclaration {
  if (tool.name === TOOL.listProjects) {
    return { ...tool, description: `${tool.description} ${LIST_PROJECTS_NOTE}` };
  }
  if (ACCOUNT_TOOLS.has(tool.name)) return tool;
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...(tool.inputSchema.properties ?? {}), projectId: PROJECT_ID_PROPERTY },
    },
  };
}

export const railwayTools: readonly McpToolDeclaration[] = [
  ...upstreamTools.map(withoutUnboundArguments),
  ...customTools,
].map(declared);

/** Tools whose forward schema takes `projectId` : the resolved project id is sent there only. */
const FORWARD_TAKES_PROJECT_ID: ReadonlySet<string> = new Set(
  [...upstreamTools, ...customTools]
    .filter((t) => 'projectId' in (t.inputSchema.properties ?? {}))
    .map((t) => t.name),
);

/** True when the service's own schema of `tool` takes a `projectId`. */
export function forwardTakesProjectId(tool: string): boolean {
  return FORWARD_TAKES_PROJECT_ID.has(tool);
}

/** Strip the `railway__` prefix to get the upstream tool name. */
export function toUpstreamName(toolName: string): string {
  return toolName.startsWith(TOOL_PREFIX) ? toolName.slice(TOOL_PREFIX.length) : toolName;
}
