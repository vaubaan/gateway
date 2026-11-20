/**
 * MCP tools of the `vercel` service — rewrap of the official Vercel MCP
 * server at mcp.vercel.com (18 tools, frozen in `upstream-tools.json`), plus
 * 14 custom REST-backed tools (`custom-tools.ts`).
 *
 * ADR  : docs/decisions/rewrap-official-mcps.md (upstream forward, custom tools).
 *
 * Names are prefixed `vercel__` (the SDK prefix rule). Refresh procedure for
 * the upstream half : POST `tools/list` to mcp.vercel.com, copy each tool
 * with the prefix added, review the classifier for any new name.
 *
 * Two schemas per rewrapped tool :
 *   - the **declared** one, what an agent reads (`vercelTools`) : the frozen
 *     upstream schema, plus the `projectId` the plugin routes on when the
 *     tool does not take one, and without `teamId` in `required` (the
 *     account's team is always the one sent) ;
 *   - the **forward** one, the frozen upstream schema as it is : what the
 *     upstream tool accepts (`toolAcceptsArgument`), so a routing argument is
 *     only sent where the service takes it.
 */

import { isRecord, type McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { customTools, isCustomTool } from './custom-tools.ts';
import { TOOL, TOOL_PREFIX } from './identity.ts';
import upstream from './upstream-tools.json' with { type: 'json' };

const upstreamTools = upstream as ReadonlyArray<McpToolDeclaration>;

/** Tools that need no project : account-rooted reads. */
export const ACCOUNT_TOOLS: ReadonlySet<string> = new Set([
  TOOL.searchVercelDocumentation,
  TOOL.listTeams,
  TOOL.listProjects,
  TOOL.checkDomainAvailabilityAndPrice,
]);

/** What an agent reads of `projectId` on a tool whose upstream schema lacks it. */
export const PROJECT_ID_PROPERTY = {
  type: 'string',
  description:
    'The Vercel project the call acts on : its id (`prj_…`) or its name, one of the projects of the mission ' +
    '(`vercel__list_projects` lists them). Optional when the mission holds one Vercel project ; required otherwise.',
} as const;

/** The declared schema of a rewrapped tool (see the module comment). */
function declared(tool: McpToolDeclaration): McpToolDeclaration {
  const schema = tool.inputSchema;
  const properties = { ...(schema.properties ?? {}) };
  if (!ACCOUNT_TOOLS.has(tool.name) && !('projectId' in properties)) {
    properties.projectId = PROJECT_ID_PROPERTY;
  }
  const required = schema.required?.filter((name) => name !== 'teamId');
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties,
      ...(required !== undefined ? { required } : {}),
    },
  };
}

/** Every tool the plugin declares, upstream first. */
export const vercelTools: readonly McpToolDeclaration[] = [
  ...upstreamTools.map(declared),
  ...customTools,
];

const byName = new Map(vercelTools.map((t) => [t.name, t] as const));
/** What each tool's own service accepts : the frozen upstream schema, a custom tool's own. */
const forwardByName = new Map([...upstreamTools, ...customTools].map((t) => [t.name, t] as const));

/** The declaration of a tool, or `undefined` for an unknown name. */
export function vercelToolByName(name: string): McpToolDeclaration | undefined {
  return byName.get(name);
}

/** True when the tool's declared input schema has the given property. */
export function toolDeclaresProperty(name: string, property: string): boolean {
  const props = byName.get(name)?.inputSchema?.properties;
  return typeof props === 'object' && props !== null && property in props;
}

/** True when the tool's declared input schema lists the property as required. */
export function toolRequiresProperty(name: string, property: string): boolean {
  return byName.get(name)?.inputSchema?.required?.includes(property) === true;
}

/**
 * True when an argument of that name may be sent to the tool's service : its
 * forward schema declares it, or is open (no `additionalProperties: false`).
 * A closed schema without the property would reject the call.
 */
export function toolAcceptsArgument(name: string, property: string): boolean {
  const schema: Readonly<Record<string, unknown>> | undefined =
    forwardByName.get(name)?.inputSchema;
  if (schema === undefined) return false;
  const props = schema.properties;
  const has = isRecord(props) && property in props;
  return has || schema.additionalProperties !== false;
}

/** Strip the `vercel__` prefix to get the upstream tool name. */
export function toUpstreamName(toolName: string): string {
  return toolName.startsWith(TOOL_PREFIX) ? toolName.slice(TOOL_PREFIX.length) : toolName;
}

export { isCustomTool };
