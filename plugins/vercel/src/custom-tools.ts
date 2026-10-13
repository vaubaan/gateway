/**
 * Vercel custom tools — REST-API-backed augmentations on top of the rewrap.
 *
 * ADR : docs/decisions/vercel-augment-with-rest-tools.md.
 *
 * The upstream MCP at mcp.vercel.com only exposes read + deploy + toolbar
 * tools — no mutation of project settings, env vars, domains or firewall. We
 * layer a small, typed-strict surface on top that hits api.vercel.com
 * directly. Any name listed here is routed by `execute.ts` to REST instead of
 * the JSON-RPC forward.
 *
 * Every custom tool takes the project ref (`projectId`) explicitly ; the
 * classifier falls back to the mission's single project when it is absent.
 * `teamId` is always the connection's team : an explicit different value is
 * refused by `execute`.
 *
 * The v4 `vercel__upsert_env_from_venv` tool (secret transfer from the
 * project env-var store) is gone : v5 has no venv counterpart (plan §8-Q5).
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

export const UPDATE_PROJECT_SETTINGS = 'vercel__update_project_settings';
export const UPSERT_ENV_VAR = 'vercel__upsert_env_var';
export const LIST_ENV_VARS = 'vercel__list_env_vars';
export const DELETE_ENV_VAR = 'vercel__delete_env_var';
export const LIST_DOMAINS = 'vercel__list_project_domains';
export const ADD_DOMAIN = 'vercel__add_project_domain';
export const VERIFY_DOMAIN = 'vercel__verify_project_domain';
export const REMOVE_DOMAIN = 'vercel__remove_project_domain';
export const GET_FIREWALL_CONFIG = 'vercel__get_firewall_config';
export const TOGGLE_FIREWALL = 'vercel__toggle_firewall';
export const UPSERT_FIREWALL_RULE = 'vercel__upsert_firewall_rule';
export const REMOVE_FIREWALL_RULE = 'vercel__remove_firewall_rule';
export const MANAGE_IP_BLOCKING = 'vercel__manage_ip_blocking';

const projectIdArg = {
  projectId: {
    type: 'string',
    description: 'Vercel project id (`prj_xxx`), one of the resources of the mission.',
  },
} as const;

const teamIdArg = {
  teamId: {
    type: 'string',
    description:
      "Team id (`team_xxx`). Optional : the connection's team is used ; a different value is refused.",
  },
} as const;

export const customTools: readonly McpToolDeclaration[] = [
  {
    name: UPDATE_PROJECT_SETTINGS,
    description:
      'Update common project settings on Vercel (root directory, framework, build/dev/install commands, output directory, node version). Backed by PATCH /v9/projects/{projectId}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdArg,
        ...teamIdArg,
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
      'Create or update an environment variable on a Vercel project. Backed by POST /v10/projects/{projectId}/env?upsert=true. Omitting `target` applies the variable to all three environments (production included) — a fan-out the catalog treats as its own risk.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdArg,
        ...teamIdArg,
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
      'List environment variables on a Vercel project. Values are returned encrypted by default; pass `decrypt: true` to receive plaintext (a distinct, high-severity risk of the catalog). Backed by GET /v10/projects/{projectId}/env.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdArg,
        ...teamIdArg,
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
      'Delete an environment variable on a Vercel project by its Vercel-issued id. The Vercel API removes the variable from every environment it lives in at once, so the gateway always classifies this call as touching all three environments. Backed by DELETE /v9/projects/{projectId}/env/{id}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdArg,
        ...teamIdArg,
        id: {
          type: 'string',
          description:
            'Vercel-issued env var id (returned by `vercel__list_env_vars`). Distinct from the variable name.',
        },
        target: {
          type: 'string',
          enum: ['production', 'preview', 'development'],
          description:
            'Informational hint only. Ignored by the Vercel API and by the gateway classifier (the delete fans out to every environment).',
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
      properties: { ...projectIdArg, ...teamIdArg },
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
        ...projectIdArg,
        ...teamIdArg,
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
        ...projectIdArg,
        ...teamIdArg,
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
        ...projectIdArg,
        ...teamIdArg,
        domain: { type: 'string', description: 'The exact domain name to detach.' },
      },
      required: ['projectId', 'domain'],
    },
  },

  // ─── Firewall / WAF tools ─────────────────────────────────────────────────

  {
    name: GET_FIREWALL_CONFIG,
    description:
      'Read the active firewall (WAF) configuration for a Vercel project — returns firewallEnabled flag, custom rules, IP blocking rules, managed rulesets, and OWASP CRS settings. Backed by GET /v1/security/firewall/config/active.',
    inputSchema: {
      type: 'object',
      properties: { ...projectIdArg, ...teamIdArg },
      required: ['projectId'],
    },
  },
  {
    name: TOGGLE_FIREWALL,
    description:
      'Enable or disable the firewall (WAF) on a Vercel project. Backed by PATCH /v1/security/firewall/config.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdArg,
        ...teamIdArg,
        enabled: {
          type: 'boolean',
          description: 'Set to `true` to enable the firewall, `false` to disable it.',
        },
      },
      required: ['projectId', 'enabled'],
    },
  },
  {
    name: UPSERT_FIREWALL_RULE,
    description:
      'Create or update a custom firewall rule on a Vercel project. When `ruleId` is provided the existing rule is updated ; otherwise a new rule is inserted. Backed by PATCH /v1/security/firewall/config with action `rules.insert` or `rules.update`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdArg,
        ...teamIdArg,
        ruleId: {
          type: 'string',
          description: 'Existing rule id to update. Omit to insert a new rule.',
        },
        name: {
          type: 'string',
          description: 'Human-readable rule name.',
        },
        description: {
          type: 'string',
          description: 'Optional description of the rule purpose.',
        },
        active: {
          type: 'boolean',
          description: 'Whether the rule is active (`true`) or disabled (`false`).',
        },
        conditionGroup: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              conditions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      description:
                        'Condition type (e.g. `ip_address`, `path`, `header`, `method`, `host`, `geo`, `cookie`, `query`, `target_path`, `region`, `protocol`, `scheme`, `environment`, `ja4_digest`, `ja3_digest`).',
                    },
                    op: {
                      type: 'string',
                      description:
                        'Operator (e.g. `eq`, `neq`, `inc`, `ninc`, `pre`, `suf`, `re`, `nre`, `ex`, `nex`, `gt`, `gte`, `lt`, `lte`, `geo`, `ngeo`, `ipmatch`, `nipmatch`).',
                    },
                    neg: { type: 'boolean', description: 'Negate the condition.' },
                    key: {
                      type: 'string',
                      description: 'Header/cookie/query key when the type requires it.',
                    },
                    value: { type: 'string', description: 'Value to match against.' },
                  },
                  required: ['type', 'op'],
                },
                description: 'Array of conditions ANDed together within this group.',
              },
            },
            required: ['conditions'],
          },
          description:
            'Array of condition groups ORed together. Each group contains ANDed conditions.',
        },
        action: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['deny', 'challenge', 'rate_limit', 'log', 'bypass'],
              description: 'Action to take when the rule matches.',
            },
            duration: {
              type: 'string',
              description:
                'Duration for temporary bans (e.g. `1h`, `24h`). Only for `deny` action.',
            },
            rateLimit: {
              type: 'object',
              properties: {
                algo: {
                  type: 'string',
                  enum: ['fixed_window', 'token_bucket'],
                  description: 'Rate-limiting algorithm.',
                },
                window: { type: 'number', description: 'Window size in seconds.' },
                limit: { type: 'number', description: 'Max requests per window.' },
                action: {
                  type: 'string',
                  enum: ['deny', 'challenge', 'log'],
                  description: 'Action when rate-limit is exceeded.',
                },
                keys: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Keys to group rate limits by (e.g. `ip`, `path`).',
                },
              },
              description: 'Rate-limit parameters (only when type is `rate_limit`).',
            },
            actionDuration: {
              type: ['string', 'null'],
              description: 'How long the action lasts after rate-limit is exceeded.',
            },
          },
          required: ['type'],
          description: 'Action to execute when the rule triggers.',
        },
      },
      required: ['projectId', 'name', 'active', 'conditionGroup', 'action'],
    },
  },
  {
    name: REMOVE_FIREWALL_RULE,
    description:
      'Remove a custom firewall rule from a Vercel project by its rule id. Backed by PATCH /v1/security/firewall/config with action `rules.remove`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdArg,
        ...teamIdArg,
        ruleId: {
          type: 'string',
          description: 'The id of the firewall rule to remove.',
        },
      },
      required: ['projectId', 'ruleId'],
    },
  },
  {
    name: MANAGE_IP_BLOCKING,
    description:
      'Add or remove an IP-based blocking / challenge / bypass / log rule in the Vercel project firewall. Use `operation: "insert"` to add an IP rule, `operation: "remove"` to delete one by its id. Backed by PATCH /v1/security/firewall/config with action `ip.insert` or `ip.remove`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdArg,
        ...teamIdArg,
        operation: {
          type: 'string',
          enum: ['insert', 'remove'],
          description: '`insert` to add an IP rule, `remove` to delete one by id.',
        },
        ip: {
          type: 'string',
          description: 'IP address or CIDR to block/challenge/log/bypass (required for `insert`).',
        },
        hostname: {
          type: 'string',
          description: 'Optional hostname restriction for the IP rule (only for `insert`).',
        },
        action: {
          type: 'string',
          enum: ['deny', 'challenge', 'log', 'bypass'],
          description: 'Action to take for this IP (only for `insert`). Defaults to `deny`.',
        },
        notes: {
          type: 'string',
          description:
            'Human-readable note about why the IP is blocked/allowed (only for `insert`).',
        },
        id: {
          type: 'string',
          description: 'IP rule id to remove (required for `remove`).',
        },
      },
      required: ['projectId', 'operation'],
    },
  },
];

const customNames = new Set(customTools.map((t) => t.name));

/** True if `name` is one of the custom REST-backed tools defined in this file. */
export function isCustomTool(name: string): boolean {
  return customNames.has(name);
}
