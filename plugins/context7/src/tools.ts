/**
 * MCP tools of the `context7` service — rewrap of the official Context7 MCP
 * server at https://mcp.context7.com/mcp.
 *
 * ADR      : docs/decisions/rewrap-official-mcps.md (the shape) ;
 *            docs/decisions/rewrap-official-mcps.md.
 * Handbook : docs/handbook/services/context7.md.
 *
 * `upstream-tools.json` is the `tools` array of `tools/list`, captured
 * verbatim from `mcp.context7.com` on 2026-10-16 : names, titles,
 * descriptions (they carry Context7's own usage rules), input schemas and
 * annotations. The gateway's declaration is the upstream one with the name
 * prefixed `context7__` ; the description and the schema's properties and
 * `required` are unchanged. A tool Context7 adds later is not in this file,
 * so it is unknown to the classifier and refused until it is modelled.
 *
 * Refresh procedure : POST `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`
 * to https://mcp.context7.com/mcp (no key needed), write the `tools` array
 * of the answer here, re-read the classifier against it, bump the plugin
 * version.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL, TOOL_PREFIX, UPSTREAM_TOOL } from './identity.ts';
import upstream from './upstream-tools.json' with { type: 'json' };

/** One tool as `tools/list` declares it, reduced to what the gateway forwards. */
interface UpstreamTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
}

function isUpstreamTool(x: unknown): x is UpstreamTool {
  if (typeof x !== 'object' || x === null) return false;
  const t = x as Record<string, unknown>;
  const schema = t.inputSchema as Record<string, unknown> | null | undefined;
  return (
    typeof t.name === 'string' &&
    typeof t.description === 'string' &&
    typeof schema === 'object' &&
    schema !== null &&
    schema.type === 'object' &&
    typeof schema.properties === 'object' &&
    schema.properties !== null &&
    (schema.required === undefined ||
      (Array.isArray(schema.required) && schema.required.every((r) => typeof r === 'string')))
  );
}

function declarationsOf(list: unknown): readonly McpToolDeclaration[] {
  if (!Array.isArray(list) || !list.every(isUpstreamTool)) {
    throw new Error(`${SERVICE_ID}: upstream-tools.json is not a list of MCP tool declarations`);
  }
  const known = new Set<string>(Object.values(UPSTREAM_TOOL));
  return list.map((tool) => {
    if (!known.has(tool.name)) {
      throw new Error(`${SERVICE_ID}: upstream tool '${tool.name}' is not modelled`);
    }
    return {
      name: `${TOOL_PREFIX}${tool.name}`,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: { ...tool.inputSchema.properties },
        ...(tool.inputSchema.required ? { required: [...tool.inputSchema.required] } : {}),
      },
    };
  });
}

export const context7Tools: readonly McpToolDeclaration[] = declarationsOf(upstream);

/**
 * What each tool does, in a few words a person reads at a glance
 * (`ServicePlugin.toolTitles`) : the head of an approval request in the web
 * interface, before the resource the call resolves to. For people only :
 * never part of `tools/list`.
 */
export const context7ToolTitles: Readonly<Record<string, string>> = {
  [TOOL.resolveLibraryId]: 'Find a library in Context7',
  [TOOL.queryDocs]: "Read a library's documentation",
};
