/**
 * Vercel custom tools — REST-API-backed augmentations on top of the rewrap.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7.4.
 * ADR  : docs/decisions/vercel-augment-with-rest-tools.md.
 *
 * The upstream MCP at mcp.vercel.com only exposes read + deploy + toolbar
 * tools — no mutation of project settings or env vars. We layer a small,
 * typed-strict surface on top that hits api.vercel.com directly. Any name
 * listed here is routed by `execute.ts` to REST instead of JSON-RPC forward.
 */

import type { McpToolDeclaration } from '@vaubaan/shared';

export const UPDATE_PROJECT_SETTINGS = 'vercel__update_project_settings';
export const UPSERT_ENV_VAR = 'vercel__upsert_env_var';

export const customTools: readonly McpToolDeclaration[] = [
  {
    name: UPDATE_PROJECT_SETTINGS,
    description:
      'Update common project settings on Vercel (root directory, framework, build/dev/install commands, output directory, node version). Backed by PATCH /v9/projects/{projectId}.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Vercel project id (e.g. `prj_xxx`).',
        },
        teamId: {
          type: 'string',
          description: 'Team id (slug or team_xxx). Auto-injected if omitted.',
        },
        rootDirectory: {
          type: ['string', 'null'],
          description:
            'Relative path inside the repository to use as the project root. Pass null to reset to repo root.',
        },
        framework: {
          type: ['string', 'null'],
          description:
            'Framework preset slug (e.g. `nextjs`, `vite`, `astro`). Pass null to use auto-detect.',
        },
        buildCommand: {
          type: ['string', 'null'],
          description: 'Override the build command. Pass null to use the framework default.',
        },
        devCommand: {
          type: ['string', 'null'],
          description: 'Override the dev command. Pass null to use the framework default.',
        },
        installCommand: {
          type: ['string', 'null'],
          description: 'Override the install command. Pass null to use the framework default.',
        },
        outputDirectory: {
          type: ['string', 'null'],
          description: 'Override the output directory. Pass null to use the framework default.',
        },
        nodeVersion: {
          type: 'string',
          description: 'Node version label as accepted by Vercel (e.g. `20.x`, `22.x`).',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: UPSERT_ENV_VAR,
    description:
      'Create or update an environment variable on a Vercel project. Backed by POST /v10/projects/{projectId}/env?upsert=true.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Vercel project id (e.g. `prj_xxx`).',
        },
        teamId: {
          type: 'string',
          description: 'Team id (slug or team_xxx). Auto-injected if omitted.',
        },
        key: {
          type: 'string',
          description: 'Environment variable name.',
        },
        value: {
          type: 'string',
          description:
            'Environment variable value. For encrypted/secret types, raw value still goes here — Vercel encrypts on write.',
        },
        target: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['production', 'preview', 'development'],
          },
          description:
            'Vercel environments to apply this variable to. Defaults to all three when omitted.',
        },
        type: {
          type: 'string',
          enum: ['plain', 'encrypted', 'sensitive'],
          description:
            'Variable type. `encrypted` is the most common default; `sensitive` hides the value from the dashboard.',
        },
        gitBranch: {
          type: ['string', 'null'],
          description:
            'Restrict this variable to a specific git branch (preview env only). Pass null for all branches.',
        },
        comment: {
          type: 'string',
          description: 'Optional human-readable note shown in the Vercel dashboard.',
        },
      },
      required: ['projectId', 'key', 'value'],
    },
  },
];

const customNames = new Set(customTools.map((t) => t.name));

/** True if `name` is one of the custom REST-backed tools defined in this file. */
export function isCustomTool(name: string): boolean {
  return customNames.has(name);
}
