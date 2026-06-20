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
export const LIST_ENV_VARS = 'vercel__list_env_vars';
export const DELETE_ENV_VAR = 'vercel__delete_env_var';
export const LIST_DOMAINS = 'vercel__list_project_domains';
export const ADD_DOMAIN = 'vercel__add_project_domain';
export const VERIFY_DOMAIN = 'vercel__verify_project_domain';
export const REMOVE_DOMAIN = 'vercel__remove_project_domain';
export const UPDATE_DEPLOYMENT_PROTECTION = 'vercel__update_deployment_protection';
export const UPSERT_ENV_FROM_VENV = 'vercel__upsert_env_from_venv';

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
  {
    name: LIST_ENV_VARS,
    description:
      'List environment variables on a Vercel project. Values are returned encrypted by default; pass `decrypt: true` to receive plaintext (requires the access token to have plaintext-read rights on Vercel). Backed by GET /v10/projects/{projectId}/env.',
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
        decrypt: {
          type: 'boolean',
          description:
            'When true, request plaintext values from Vercel (`?decrypt=true`). Default false.',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: DELETE_ENV_VAR,
    description:
      'Delete an environment variable on a Vercel project by its Vercel-issued id. Pass `target` to declare which Vaubaan env this delete touches — the gateway uses it to gate the capability (write@prod, write@preview, …). Backed by DELETE /v9/projects/{projectId}/env/{id}.',
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
        id: {
          type: 'string',
          description:
            'Vercel-issued env var id (returned by `vercel__list_env_vars`). Distinct from the variable name.',
        },
        target: {
          type: 'string',
          enum: ['production', 'preview', 'development'],
          description:
            'Vaubaan env target hint for capability gating. The Vercel API does not need it (the var is removed from all its targets at once), but Vaubaan uses it to require `config:write@<env>`. Defaults to `production` (conservative).',
        },
      },
      required: ['projectId', 'id'],
    },
  },
  {
    name: LIST_DOMAINS,
    description:
      'List custom domains attached to a Vercel project (including verification status). Backed by GET /v9/projects/{projectId}/domains.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Vercel project id (e.g. `prj_xxx`).' },
        teamId: {
          type: 'string',
          description: 'Team id (slug or team_xxx). Auto-injected if omitted.',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: ADD_DOMAIN,
    description:
      'Attach a custom domain to a Vercel project. Backed by POST /v10/projects/{projectId}/domains. If `verified: false` in the response, call `verify_project_domain` after configuring DNS.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        teamId: { type: 'string' },
        name: {
          type: 'string',
          description: 'The domain name to attach (e.g. `www.example.com`).',
        },
        gitBranch: {
          type: 'string',
          description: 'Optional Git branch this domain mirrors (preview-style branch deploys).',
        },
        redirect: {
          type: 'string',
          description: 'Redirect target domain (e.g. `example.com`).',
        },
        redirectStatusCode: {
          type: 'number',
          enum: [301, 302, 307, 308],
          description: 'HTTP redirect status code when `redirect` is set.',
        },
      },
      required: ['projectId', 'name'],
    },
  },
  {
    name: VERIFY_DOMAIN,
    description:
      'Trigger Vercel re-check of a domain attachment (re-runs the verification challenge after DNS records are in place). Backed by POST /v9/projects/{projectId}/domains/{domain}/verify.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        teamId: { type: 'string' },
        domain: { type: 'string', description: 'The exact domain name attached to the project.' },
      },
      required: ['projectId', 'domain'],
    },
  },
  {
    name: REMOVE_DOMAIN,
    description:
      'Detach a custom domain from a Vercel project. Backed by DELETE /v9/projects/{projectId}/domains/{domain}.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        teamId: { type: 'string' },
        domain: { type: 'string', description: 'The exact domain name to detach.' },
      },
      required: ['projectId', 'domain'],
    },
  },
  {
    name: UPDATE_DEPLOYMENT_PROTECTION,
    description:
      'Toggle / configure Vercel deployment protection (Vercel Auth SSO + Password Protection). Backed by PATCH /v9/projects/{projectId} with `ssoProtection` and/or `passwordProtection` fields. Pass `null` for a field to disable it.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        teamId: { type: 'string' },
        ssoProtection: {
          type: ['object', 'null'],
          description:
            'Vercel SSO/team auth — `{ deploymentType: "all" | "preview" | "prod_deployment_urls_and_all_previews" | null }`. Pass null to disable.',
        },
        passwordProtection: {
          type: ['object', 'null'],
          description:
            'Password gate — `{ password: string, deploymentType: same enum as ssoProtection }`. Pass null to disable.',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: UPSERT_ENV_FROM_VENV,
    description:
      "Deploy an env var from this project's venv store to a Vercel project. The secret value is read server-side from venv and pushed directly to Vercel — it is NEVER returned in the tool response. Use a `_to_venv` tool (e.g. `supabase__service_role_to_venv`) to populate the venv key first.",
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
        venv_key: {
          type: 'string',
          description:
            'The env var key to read from venv (e.g. `SUPABASE_SERVICE_ROLE_KEY`). This same key name is used as the Vercel env var name.',
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
          description: 'Variable type. Defaults to `encrypted`.',
        },
      },
      required: ['projectId', 'venv_key'],
    },
  },
];

const customNames = new Set(customTools.map((t) => t.name));

/** True if `name` is one of the custom REST-backed tools defined in this file. */
export function isCustomTool(name: string): boolean {
  return customNames.has(name);
}
