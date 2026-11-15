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
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { customTools } from './custom-tools.ts';
import { TOOL, TOOL_PREFIX } from './identity.ts';
import upstream from './upstream-tools.json' with { type: 'json' };

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

export const railwayTools: readonly McpToolDeclaration[] = [
  ...(upstream as ReadonlyArray<McpToolDeclaration>).map(withoutUnboundArguments),
  ...customTools,
];

/** Strip the `railway__` prefix to get the upstream tool name. */
export function toUpstreamName(toolName: string): string {
  return toolName.startsWith(TOOL_PREFIX) ? toolName.slice(TOOL_PREFIX.length) : toolName;
}
