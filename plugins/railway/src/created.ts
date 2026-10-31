/**
 * The project a successful `railway__create-project` created, read from the
 * answer of Railway's MCP server (ADR created-resources-join-the-mission).
 * Handbook : docs/handbook/providers/railway.md.
 *
 * ⚠ Railway does not document what `create-project` answers. The plugin
 * forwards the answer as is, so the hook reads it defensively : a JSON answer
 * (structured content or a JSON text block) that holds, at any depth, an
 * object whose `id` passes the Railway identifier grammar and whose `name` is
 * the name the call asked for. Exactly one such project, or nothing : a text
 * answer, or one that names several projects, gives `[]` and the project waits
 * for the discovery that follows the call. The resource is described as
 * discovery describes it : `metadata.environments` and `metadata.services` as
 * `{ id, name }` lists, empty when the answer does not carry them.
 */

import {
  isList,
  isRecord,
  jsonValuesOf,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { railwayId } from './classify.ts';
import { nodesOf } from './graphql.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';
/** How deep the answer is searched for the project. */
const MAX_DEPTH = 6;

interface Named {
  readonly id: string;
  readonly name: string;
}

/** `ProviderPlugin.createdResources` : the project `create-project` made, or `[]`. */
export function createdRailwayResources(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  result: McpToolResult,
): readonly Resource[] {
  if (tool !== TOOL.createProject || typeof args.name !== 'string' || args.name === '') return [];
  const wanted = args.name;
  const found = new Map<string, Record<string, unknown>>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (isList(value)) {
      value.forEach((v) => visit(v, depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    const id = railwayId(value.id);
    if (id !== null && value.name === wanted && !found.has(id)) found.set(id, value);
    Object.values(value).forEach((v) => visit(v, depth + 1));
  };
  jsonValuesOf(result).forEach((v) => visit(v, 0));
  if (found.size !== 1) return [];
  const [[id, project] = []] = [...found.entries()];
  if (id === undefined || project === undefined) return [];
  return [
    {
      provider: PROVIDER_ID,
      ref: id,
      displayName: wanted,
      metadata: {
        environments: namedList(project.environments),
        services: namedList(project.services),
      },
    },
  ];
}

/** A `{ id, name }` list from an array or a GraphQL connection (`{ edges: [{ node }] }`). */
function namedList(value: unknown): Named[] {
  const out: Named[] = [];
  for (const { id, name } of nodesOf(value)) {
    const checked = railwayId(id);
    if (checked !== null && typeof name === 'string') out.push({ id: checked, name });
  }
  return out;
}
