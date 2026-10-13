/**
 * Bootstrap kit shown after a mission is issued (spec §4.4): three numbered
 * snippets and a verification command.
 *
 *   1. the environment variable carrying the mission token (the secret is in
 *      it only when the kit is built right after issuance or rotation; a
 *      revisited page gets the masked prefix);
 *   2. the client's MCP configuration: the instance URL and the Authorization
 *      header by reference to the variable, never the secret itself;
 *   3. the instruction block for the agent: whose token it holds (every token
 *      of a mission has one holder), connections, resource refs, accepted
 *      risks, budget, what to do on each structured refusal and when the
 *      token itself stops working, and a short "management door" section — the other MCP door of the instance,
 *      which this token does not open;
 *   +  `curl … tools/list`.
 *
 * Pure: the instance URL comes from the configuration (`public_url`), nothing
 * is hard-coded but the paths of the two MCP doors on this instance.
 */
import { AUTH_FAILURE_REASONS, type AuthFailureReason } from '@vaubaan/gateway-core';
import { REFUSAL_CODES, type MissionPolicyEntry, type RefusalCode } from '@vaubaan/shared';

import { MANAGEMENT_DOOR_PATH } from '../oauth-as/endpoints';
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
/**
 * The shape of an agent label, stated once: the execution door checks it
 * (`server/execution/request-meta.ts`) and the kit tells the agents.
 * ASCII letters and digits, plus these characters after the first one.
 */
export const AGENT_LABEL_MAX_LENGTH = 64;
export const AGENT_LABEL_PUNCTUATION = '._-:/@+';

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
    'the mission is expired, orphaned or revoked. Stop calling with this token and report to the human: a revoked mission needs a new one, an expired one an extension, and an orphaned one works again with this same token once the authority behind it is back. A request opened before the mission was orphaned can be granted only until it expires; after that, your next refused call opens a new one.',
  'wrong-credential-kind':
    'this token was presented on the wrong door. A mission token only opens the execution endpoint above; do not send it anywhere else.',
};

/**
 * What the agent does when its token stops authenticating (HTTP 401 with
 * `error.data.reason`). Not refusals: the mission may be serving its other
 * holders. Keyed by the closed set of reasons, so a new one fails to compile
 * until it has its line.
 */
export const TOKEN_STOPPED_GUIDANCE: Readonly<Record<AuthFailureReason, string>> = {
  'token-rotated':
    'the holder of this token generated a newer one. Ask the human who gave you this token for the new one; do not look for another token.',
  'token-revoked':
    'this token was revoked by its holder or by the mission creator. The mission may still be running for others. Stop, and tell the human.',
  'holder-removed':
    'the holder of this token is no longer a member of the mission. Stop, and tell the human.',
  'holder-deactivated':
    'the holder of this token was deactivated on this instance. Stop, and tell the human.',
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

/**
 * The "management door" section of the instruction block: an executing agent
 * must know the other door exists, that its mission token does not open it,
 * and that nothing behind it lifts a refusal.
 */
export function managementDoorSection(managementEndpoint: string): string[] {
  return [
    '### The management door',
    `This instance has a second MCP server, ${managementEndpoint}, for an agent acting on behalf of a user: it reads the user's connections and missions and issues, rotates or revokes missions in the user's name, within the user's authority. It is opened by an OAuth consent the user gives in a browser, never by this mission token (presenting it there is refused as \`wrong-credential-kind\`).`,
    "It does not lift a refusal: answering a claim or an approval, opening a gate, extending a budget, connecting or sharing a provider are done by the human in the web interface, and by nobody else. If you also hold a delegation there, do not use it to issue yourself a wider mission in order to get past a refusal: the mission would appear under the user's name, marked as issued by you.",
  ];
}

/**
 * The label section of the instructions (spec §7.9): how an orchestrator
 * hands its configuration to sub-agents, and how each says who it is.
 */
function agentLabelGuidance(): string[] {
  const punctuation = [...AGENT_LABEL_PUNCTUATION].map((c) => `\`${c}\``).join(' ');
  return [
    '### Sub-agents and agent labels',
    `- An orchestrator hands its sub-agents this MCP configuration as is: same endpoint, same \`${MISSION_TOKEN_ENV}\`. A token belongs to its holder (a person, or a machine the mission creator named), not to an agent: there is no token per agent, and nothing to request for a new one.`,
    `- So that the session and the audit tell who did what, each agent names itself with a label. A sub-agent started with its own copy of the configuration adds the header \`${AGENT_LABEL_HEADER}: <label>\` next to \`Authorization\`. An orchestrator that sends the calls itself on behalf of several agents sets \`_meta.${AGENT_LABEL_META_KEY}\` on each \`tools/call\` instead; on a call that carries both, \`_meta.${AGENT_LABEL_META_KEY}\` wins.`,
    `- A label is 1 to ${AGENT_LABEL_MAX_LENGTH} characters: letters, digits and ${punctuation}, starting with a letter or a digit (\`planner\`, \`sub-agent-2\`, \`team/reviewer\`). Anything else is ignored: the call is served, unlabelled.`,
    '- A label is attribution only. It changes nothing about what is allowed or counted, it reserves no share of the budget, and it is not an identity: never put a secret in it. The identity of a call is the holder of its token, which you cannot change.',
  ];
}

function agentInstructions(
  input: BootstrapKitInput,
  endpoint: string,
  managementEndpoint: string,
): string {
  const { mission } = input;
  const connections = input.connections.map((c) => {
    const resources =
      c.resources.length === 0
        ? 'no resource (account-level tools only)'
        : c.resources.map(resourceLine).join(', ');
    return `- ${c.provider_label} "${c.display_name}" — ${resources}`;
  });
  const refusals = REFUSAL_CODES.map((code) => `- \`${code}\` — ${REFUSAL_GUIDANCE[code]}`);
  const stopped = AUTH_FAILURE_REASONS.map(
    (reason) => `- \`${reason}\` — ${TOKEN_STOPPED_GUIDANCE[reason]}`,
  );
  return [
    `## Vaubaan mission "${mission.name}"`,
    '',
    `You reach the company's cloud providers only through the Vaubaan Gateway MCP server \`${MCP_SERVER_NAME}\` (${endpoint}), authenticated by the mission token in \`${MISSION_TOKEN_ENV}\`. You hold no provider credential and must not look for one. Sub-agents use the same MCP configuration and the same token: the budget below is shared, it is not multiplied.`,
    '',
    '### Whose token this is',
    `- This token belongs to one holder, and every call you make with it is recorded under that holder's name in the session and the audit of the mission. \`GET ${endpoint}/catalog\` tells you who (\`token.holder\`) and who created the mission (\`mission.creator\`).`,
    '- Other people or machines may work on this mission with their own tokens. The budget is one for all of them: what they spend is spent for you too.',
    '- Requests (claims, approvals) are answered by the mission creator alone, whoever holds the token that caused them.',
    '',
    ...agentLabelGuidance(),
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
    '',
    '### When the token itself stops working',
    'An HTTP 401 whose `error.data.reason` is set means this token authenticated before and no longer does. It says nothing about the mission:',
    ...stopped,
    '',
    ...managementDoorSection(managementEndpoint),
  ].join('\n');
}

export function buildBootstrapKit(input: BootstrapKitInput): BootstrapKit {
  const instance = input.instanceUrl.replace(/\/+$/, '');
  const endpoint = `${instance}${EXECUTION_DOOR_PATH}`;
  const managementEndpoint = `${instance}${MANAGEMENT_DOOR_PATH}`;
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
    agent_instructions: agentInstructions(input, endpoint, managementEndpoint),
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
