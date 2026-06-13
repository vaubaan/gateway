/**
 * Railway custom tools — GraphQL augmentations on top of the MCP rewrap.
 *
 * The upstream MCP at mcp.railway.com does not expose env-var management as a
 * typed tool (only `railway-agent`, a chat-style fallback). We layer a small
 * GraphQL-backed surface on top that hits backboard.railway.com/graphql/v2
 * directly. Any name listed here is routed by `execute.ts` to GraphQL instead
 * of the MCP JSON-RPC forward.
 *
 * Token : the upstream OAuth token is audience-bound to mcp.railway.com via
 * RFC 8707. Whether Railway accepts the same Bearer against backboard is
 * empirical — we send it ; a 401 surfaces clearly to the caller.
 */

import type { McpToolDeclaration } from '@vaubaan/shared';

const projectIdArg = {
  projectId: {
    type: 'string',
    description: 'Railway project id (UUID). Resolved from the matched binding when omitted.',
  },
} as const;
const envIdArg = {
  environmentId: {
    type: 'string',
    description: 'Railway environment id (UUID). Required — varies per env (production, staging…).',
  },
} as const;
const serviceIdArg = {
  serviceId: {
    type: 'string',
    description:
      'Railway service id (UUID). Omit for shared (project-level) variables; pass for service-scoped ones.',
  },
} as const;

export const LIST_VARIABLES = 'railway__list-variables';
export const UPSERT_VARIABLE = 'railway__upsert-variable';
export const UPSERT_VARIABLES = 'railway__upsert-variables';
export const DELETE_VARIABLE = 'railway__delete-variable';

export const CUSTOM_TOOL_NAMES = new Set<string>([
  LIST_VARIABLES,
  UPSERT_VARIABLE,
  UPSERT_VARIABLES,
  DELETE_VARIABLE,
]);

export const customTools: readonly McpToolDeclaration[] = [
  {
    name: LIST_VARIABLES,
    description:
      'List environment variables on a Railway project / environment / service. Backed by GraphQL `variables(projectId, environmentId, serviceId)`. Returns an object mapping each variable name to its (rendered) value. Pass `unrendered: true` to keep `${{Ref}}` references intact.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdArg,
        ...envIdArg,
        ...serviceIdArg,
        unrendered: {
          type: 'boolean',
          description: 'When true, return raw `${{Ref.X}}` references instead of resolved values.',
        },
      },
      required: ['environmentId'],
    },
  },
  {
    name: UPSERT_VARIABLE,
    description:
      'Create or update a single Railway env var. Backed by GraphQL `variableUpsert(VariableUpsertInput)`. Pass `skipDeploys: true` to mutate the value without triggering a redeploy.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdArg,
        ...envIdArg,
        ...serviceIdArg,
        name: { type: 'string', description: 'Variable name (e.g. `API_KEY`).' },
        value: { type: 'string', description: 'Variable value (literal or `${{Ref.X}}`).' },
        skipDeploys: {
          type: 'boolean',
          description: 'When true, skip the redeploy that Railway triggers by default.',
        },
      },
      required: ['environmentId', 'name', 'value'],
    },
  },
  {
    name: UPSERT_VARIABLES,
    description:
      'Bulk-upsert Railway env vars in one call. Backed by GraphQL `variableCollectionUpsert(VariableCollectionUpsertInput)`. ⚠ With `replace: true`, ANY variable not present in `variables` is DELETED — destructive.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdArg,
        ...envIdArg,
        ...serviceIdArg,
        variables: {
          type: 'object',
          description: 'Object mapping each variable name to its string value.',
        },
        replace: {
          type: 'boolean',
          description:
            'When true, delete any existing variable not in `variables`. Use sparingly — this is destructive.',
        },
        skipDeploys: {
          type: 'boolean',
          description: 'When true, skip the redeploy that Railway triggers by default.',
        },
      },
      required: ['environmentId', 'variables'],
    },
  },
  {
    name: DELETE_VARIABLE,
    description:
      'Delete a single Railway env var by name. Backed by GraphQL `variableDelete(VariableDeleteInput)`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdArg,
        ...envIdArg,
        ...serviceIdArg,
        name: { type: 'string', description: 'Variable name to delete.' },
      },
      required: ['environmentId', 'name'],
    },
  },
];
