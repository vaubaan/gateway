/**
 * Bootstrap kit shown after a mission is issued (spec §4.4): three numbered
 * snippets and a verification command.
 *
 *   1. the environment variable carrying the mission token (the secret is in
 *      it only when the kit is built right after issuance or rotation; a
 *      revisited page gets the masked prefix);
 *   2. the client's MCP configuration: the instance URL and the Authorization
 *      header by reference to the variable, never the secret itself;
 *   3. the instruction block for the agent: connections, resource refs,
 *      accepted risks, budget, and what to do on each structured refusal;
 *   +  `curl … tools/list`.
 *
 * Pure: the instance URL comes from the configuration (`public_url`), nothing
 * is hard-coded but the path of the execution door on this instance.
 */
import { REFUSAL_CODES, type MissionPolicyEntry, type RefusalCode } from '@vaubaan/shared';

import type { DraftPeriod } from './model';
import { expiryPhrase, periodPhrase, reloadPhrase } from './summary';
import { maskedToken } from './token';

/** The variable every snippet refers to. */
export const MISSION_TOKEN_ENV = 'VAUBAAN_MISSION_TOKEN';
/** Path of the execution MCP door on the instance (`src/app/mcp/route.ts`). */
export const EXECUTION_DOOR_PATH = '/mcp';
/** Name of the server entry in the client's MCP configuration. */
export const MCP_SERVER_NAME = 'vaubaan';
/** Optional HTTP header carrying a free-form agent label (audit attribution only). */
export const AGENT_LABEL_HEADER = 'X-Vaubaan-Agent';
/** Key of the same label inside `params._meta` of one `tools/call`; wins over the header. */
export const AGENT_LABEL_META_KEY = 'agent';

export interface KitResource {
  readonly ref: string;
  readonly env: string | null;
}

export interface KitConnection {
  readonly provider_label: string;
  readonly display_name: string;
  readonly resources: readonly KitResource[];
}

export interface KitPolicyLine extends MissionPolicyEntry {
  readonly label: string;
}

export interface BootstrapKitInput {
  /** `InstanceConfig.publicUrl`, as an origin (plus sub-path), no trailing slash. */
  readonly instanceUrl: string;
  readonly mission: {
    readonly name: string;
    readonly period: DraftPeriod;
    readonly expires_at: string | null;
  };
  readonly connections: readonly KitConnection[];
  readonly policy: readonly KitPolicyLine[];
  /** The secret right after issuance or rotation; the prefix on a revisited page. */
  readonly token: { readonly secret: string } | { readonly prefix: string };
}

export interface BootstrapKit {
  readonly endpoint: string;
  /** 1. */
  readonly env: string;
  /** 2. */
  readonly mcp_json: string;
  /** 3. */
  readonly agent_instructions: string;
  /** Verification command. */
  readonly verify: string;
  /** False when the kit only carries the masked prefix. */
  readonly reveals_secret: boolean;
}

const NEVER_WORK_AROUND =
  'Never work around a refusal: no other tool, no other token, no direct access to the provider, no splitting of an action to slip under a limit.';

/**
 * What the agent does on each structured refusal (spec §4.1). Keyed by the
 * closed set of codes, so a new code fails to compile until it has its line.
 */
export const REFUSAL_GUIDANCE: Readonly<Record<RefusalCode, string>> = {
  'risk-not-accepted':
    'the mission does not accept this action. Do not look for another way to obtain the same effect. Tell the human which risks are missing (`missing_risks`); only the mission creator can enlarge the mission.',
  'budget-exhausted':
    'the quota of that risk is spent for the period. Stop that kind of action, hand `claim_url` to the human so the mission creator can grant a reset or an extension, and continue with work that does not need it. Do not retry in a loop.',
  'approval-required':
    'the action needs the mission creator’s approval. Nothing was executed. Hand `approval_url` to the human, wait, then replay the call with exactly the same arguments; any change asks again.',
  'resource-not-in-mission':
    'the arguments cite a resource outside the mission. Use one of the refs listed above (`allowed_resources`), or ask the human to have the resource added.',
  'rate-limited':
    'too many actions on that risk in a short window. Wait `retry_after_seconds`, then retry once; the quota was not consumed.',
  'connection-unavailable':
    'the provider connection is expired or revoked. Nothing you can do fixes it: tell the human who owns the connection (`owner`).',
  'mission-inactive':
    'the mission is expired, orphaned or revoked. Stop calling with this token and report to the human; a new mission must be issued.',
  'wrong-credential-kind':
    'this token was presented on the wrong door. A mission token only opens the execution endpoint above; do not send it anywhere else.',
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resourceLine(resource: KitResource): string {
  return resource.env ? `\`${resource.ref}\` (${resource.env})` : `\`${resource.ref}\``;
}

function policyLine(entry: KitPolicyLine, period: DraftPeriod): string {
  const gate = entry.gate === 'approval' ? 'each action needs approval' : 'auto';
  return `- \`${entry.risk_id}\` — ${entry.label}: ${entry.quota} ${periodPhrase(period)}, at most ${entry.rate_limit.max} per ${entry.rate_limit.window_seconds}s, ${gate}`;
}

function agentInstructions(input: BootstrapKitInput, endpoint: string): string {
  const { mission } = input;
  const connections = input.connections.map((c) => {
    const resources =
      c.resources.length === 0
        ? 'no resource (account-level tools only)'
        : c.resources.map(resourceLine).join(', ');
    return `- ${c.provider_label} "${c.display_name}" — ${resources}`;
  });
  const refusals = REFUSAL_CODES.map((code) => `- \`${code}\` — ${REFUSAL_GUIDANCE[code]}`);
  return [
    `## Vaubaan mission "${mission.name}"`,
    '',
    `You reach the company's cloud providers only through the Vaubaan Gateway MCP server \`${MCP_SERVER_NAME}\` (${endpoint}), authenticated by the mission token in \`${MISSION_TOKEN_ENV}\`. You hold no provider credential and must not look for one. Sub-agents use the same MCP configuration and the same token: the budget below is shared, it is not multiplied.`,
    '',
    `To tell several agents apart in the audit, each may add a label of its own: the HTTP header \`${AGENT_LABEL_HEADER}: <label>\` in its MCP configuration, or \`_meta.${AGENT_LABEL_META_KEY}\` on a single call. A label changes nothing about what is allowed.`,
    '',
    '### Connections and resources you may touch',
    ...connections,
    '',
    `### Accepted risks and budget (${reloadPhrase(mission.period)}; the mission ${expiryPhrase(mission.expires_at)})`,
    ...input.policy.map((entry) => policyLine(entry, mission.period)),
    '',
    'Anything else is refused. Call `tools/list` to see the tools this mission makes callable.',
    '',
    '### When a call is refused',
    'A refusal is a structured error with a `code` and a `hint`. Read the hint, then:',
    ...refusals,
    '',
    `${NEVER_WORK_AROUND} When a refusal carries a URL, give that URL to the human as is.`,
  ].join('\n');
}

export function buildBootstrapKit(input: BootstrapKitInput): BootstrapKit {
  const endpoint = `${input.instanceUrl.replace(/\/+$/, '')}${EXECUTION_DOOR_PATH}`;
  const revealsSecret = 'secret' in input.token;
  const tokenValue = 'secret' in input.token ? input.token.secret : maskedToken(input.token.prefix);

  const mcpConfig = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: endpoint,
        headers: { Authorization: `Bearer \${${MISSION_TOKEN_ENV}}` },
      },
    },
  };

  return {
    endpoint,
    env: `export ${MISSION_TOKEN_ENV}=${shellQuote(tokenValue)}`,
    mcp_json: JSON.stringify(mcpConfig, null, 2),
    agent_instructions: agentInstructions(input, endpoint),
    verify: [
      `curl -sS ${shellQuote(endpoint)} \\`,
      `  -H "Authorization: Bearer $${MISSION_TOKEN_ENV}" \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'Accept: application/json, text/event-stream' \\`,
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    ].join('\n'),
    reveals_secret: revealsSecret,
  };
}
