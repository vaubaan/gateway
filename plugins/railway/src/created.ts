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

import { jsonValuesOf, type McpToolResult, type Resource } from '@vaubaan/plugin-sdk';

import { PROVIDER, railwayId } from './classify.ts';

const CREATE_PROJECT = 'railway__create-project';
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
  if (tool !== CREATE_PROJECT || typeof args.name !== 'string' || args.name === '') return [];
  const wanted = args.name;
  const found = new Map<string, Record<string, unknown>>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, depth + 1));
      return;
    }
    const o = value as Record<string, unknown>;
    const id = railwayId(o.id);
    if (id !== null && o.name === wanted && !found.has(id)) found.set(id, o);
    Object.values(o).forEach((v) => visit(v, depth + 1));
  };
  jsonValuesOf(result).forEach((v) => visit(v, 0));
  if (found.size !== 1) return [];
  const [[id, project] = []] = [...found.entries()];
  if (id === undefined || project === undefined) return [];
  return [
    {
      provider: PROVIDER,
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
  const edges: unknown =
    typeof value === 'object' && value !== null ? (value as { edges?: unknown }).edges : undefined;
  const items: readonly unknown[] = Array.isArray(value)
    ? value
    : Array.isArray(edges)
      ? edges.map((e: unknown) =>
          typeof e === 'object' && e !== null ? (e as { node?: unknown }).node : undefined,
        )
      : [];
  const out: Named[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, name } = item as { id?: unknown; name?: unknown };
    const checked = railwayId(id);
    if (checked !== null && typeof name === 'string') out.push({ id: checked, name });
  }
  return out;
}
