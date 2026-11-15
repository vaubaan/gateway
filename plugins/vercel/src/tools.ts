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
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { customTools, isCustomTool } from './custom-tools.ts';
import { TOOL_PREFIX } from './identity.ts';
import upstream from './upstream-tools.json' with { type: 'json' };

const upstreamTools = upstream as ReadonlyArray<McpToolDeclaration>;

/** Every tool the plugin declares, upstream first. */
export const vercelTools: readonly McpToolDeclaration[] = [...upstreamTools, ...customTools];

const byName = new Map(vercelTools.map((t) => [t.name, t] as const));

/** The declaration of a tool, or `undefined` for an unknown name. */
export function vercelToolByName(name: string): McpToolDeclaration | undefined {
  return byName.get(name);
}

/** True when the tool's input schema declares the given property (used for argument injection). */
export function toolDeclaresProperty(name: string, property: string): boolean {
  const decl = byName.get(name);
  const props = decl?.inputSchema?.properties;
  return typeof props === 'object' && props !== null && property in props;
}

/** True when the tool's input schema lists the property as required. */
export function toolRequiresProperty(name: string, property: string): boolean {
  return byName.get(name)?.inputSchema?.required?.includes(property) === true;
}

/**
 * True when an argument of that name may be sent to the tool : the schema
 * declares it, or the schema is open (no `additionalProperties: false`). A
 * closed schema without the property would reject the call.
 */
export function toolAcceptsArgument(name: string, property: string): boolean {
  const schema: Readonly<Record<string, unknown>> | undefined = byName.get(name)?.inputSchema;
  if (schema === undefined) return false;
  return toolDeclaresProperty(name, property) || schema.additionalProperties !== false;
}

/** Strip the `vercel__` prefix to get the upstream tool name. */
export function toUpstreamName(toolName: string): string {
  return toolName.startsWith(TOOL_PREFIX) ? toolName.slice(TOOL_PREFIX.length) : toolName;
}

export { isCustomTool };
