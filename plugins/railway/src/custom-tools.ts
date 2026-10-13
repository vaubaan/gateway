/**
 * Railway custom tools — GraphQL augmentations on top of the MCP rewrap.
 *
 * The upstream MCP at mcp.railway.com does not expose variable management as
 * typed tools (only `railway-agent`, a chat-style fallback). These four tools
 * hit `backboard.railway.com/graphql/v2` directly ; `execute.ts` routes any
 * name listed here to GraphQL instead of the MCP JSON-RPC forward.
 *
 * Token : the OAuth token is audience-bound to mcp.railway.com (RFC 8707).
 * Whether backboard accepts the same Bearer is empirical — a 401 surfaces as
 * `UpstreamAuthError` with the upstream message.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

const projectIdArg = {
  projectId: {
    type: 'string',
    description:
      'Railway project id (UUID), one of the mission resources. Resolved from the mission when it touches a single Railway project.',
  },
} as const;
const envIdArg = {
  environmentId: {
    type: 'string',
    description:
      'Railway environment id (UUID). Required — varies per environment (production, staging…).',
  },
} as const;
const serviceIdArg = {
  serviceId: {
    type: 'string',
    description:
      'Railway service id (UUID). Omit for shared (project-level) variables ; pass for service-scoped ones.',
  },
} as const;

export const LIST_VARIABLES = 'railway__list-variables';
export const UPSERT_VARIABLE = 'railway__upsert-variable';
export const UPSERT_VARIABLES = 'railway__upsert-variables';
export const DELETE_VARIABLE = 'railway__delete-variable';

export const CUSTOM_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
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
      'Create or update a single Railway environment variable. Backed by GraphQL `variableUpsert(VariableUpsertInput)`. Pass `skipDeploys: true` to change the value without triggering a redeploy.',
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
      'Bulk-upsert Railway environment variables in one call. Backed by GraphQL `variableCollectionUpsert(VariableCollectionUpsertInput)`. With `replace: true`, ANY variable not present in `variables` is DELETED — destructive.',
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
      'Delete a single Railway environment variable by name. Backed by GraphQL `variableDelete(VariableDeleteInput)`.',
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
