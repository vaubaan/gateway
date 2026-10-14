/**
 * Bootstrap kit shown after a mission is issued (spec §4.4): three numbered
 * snippets and a verification command.
 *
 *   1. the environment variable carrying the mission key (the secret is in
 *      it only when the kit is built right after issuance or rotation; a
 *      revisited page gets the masked prefix);
 *   2. the client's MCP configuration: the instance URL and the Authorization
 *      header by reference to the variable, never the secret itself;
 *   3. the instruction block for the agent: whose token it holds (every token
 *      of a mission has one holder), connections, resource refs, accepted
 *      risks, budget, what to do on each structured refusal and when the
 *      token itself stops working, and a short "management door" section — the other MCP door of the instance,
 *      which this token does not open;
 *   4. when the mission holds an account of the provider the instance is the
 *      git remote of (spec §4.1 ter): git's configuration — a credential
 *      helper that reads the variable (never `store` or `cache`, never the
 *      key in a URL) and the recommended `insteadOf` rewrite of the
 *      provider's URLs — and the remote of each repository;
 *   +  `curl … tools/list`.
 *
 * Pure: the instance URL comes from the configuration (`public_url`), nothing
 * is hard-coded but the paths of the two MCP doors on this instance.
 */
import { AUTH_FAILURE_REASONS, type AuthFailureReason } from '@vaubaan/gateway-core';
import { REFUSAL_CODES, type MissionPolicyEntry, type RefusalCode } from '@vaubaan/shared';

import { MANAGEMENT_DOOR_PATH } from '../oauth-as/endpoints';
import type { DraftPeriod } from './model';
import { expiryPhrase, periodPhrase } from './summary';
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
  /** The git remote, when the mission has repositories it serves; absent otherwise. */
  readonly git?: KitGitRemote | null;
}

export interface KitGitRemote {
  /** `<public_url>/git/`. */
  readonly base: string;
  /** The provider's own git URL prefix the kit rewrites to `base` (from the plugin), or none. */
  readonly insteadOf: string | null;
  /** The resource refs it serves for this mission (`acme/app`). */
  readonly repositories: readonly string[];
}

export interface BootstrapKit {
  readonly endpoint: string;
  /** 1. */
  readonly env: string;
  /** 2. */
  readonly mcp_json: string;
  /** 3. */
  readonly agent_instructions: string;
  /** 4. git's configuration and the remotes; `null` when the mission has no repository the instance serves. */
  readonly git: string | null;
  /** Verification command. */
  readonly verify: string;
  /** False when the kit only carries the masked prefix. */
  readonly reveals_secret: boolean;
}

const NEVER_WORK_AROUND =
  'Never work around a refusal: no other tool, no other key, no direct access to the service, no splitting of an action to slip under a limit.';

/**
 * What the agent does on each structured refusal (spec §4.1). Keyed by the
 * closed set of codes, so a new code fails to compile until it has its line.
 */
export const REFUSAL_GUIDANCE: Readonly<Record<RefusalCode, string>> = {
  'risk-not-accepted':
    'the mission does not hold the permission for this action. Do not look for another way to obtain the same effect. Tell the human which permissions are missing (`missing_risks`); only the mission creator can enlarge the mission.',
  'budget-exhausted':
    'the limit of that permission is reached for the period. Stop that kind of action, hand `claim_url` to the human so the mission creator can reset or raise the limit, and continue with work that does not need it. Do not retry in a loop.',
  'approval-required':
    'the mission creator asked to be asked first for this action. Nothing was executed. Hand `approval_url` to the human, wait for their yes, then replay the call with exactly the same arguments; any change asks again.',
  'resource-not-in-mission':
    'the arguments cite a resource outside the mission. Use one of the refs listed above (`allowed_resources`), or ask the human to have the resource added.',
  'rate-limited':
    'too many actions on that permission in a short window. Wait `retry_after_seconds`, then retry once; nothing was counted against the limit.',
  'connection-unavailable':
    'the account behind this mission needs reconnecting or was disconnected. Nothing you can do fixes it: tell the human who owns the account (`owner`).',
  'mission-inactive':
    'the mission is expired, without an owner (`orphaned`) or stopped (`revoked`). Stop calling with this key and report to the human: a stopped mission needs a new one, an expired one more time, and one without an owner works again with this same key once its creator may allow its permissions again. A request opened before the mission lost its owner can be answered only until it expires; after that, your next refused call opens a new one.',
  'wrong-credential-kind':
    'this key was presented on the wrong door. A mission key only opens the execution endpoint above; do not send it anywhere else.',
};

/**
 * What the agent does when its token stops authenticating (HTTP 401 with
 * `error.data.reason`). Not refusals: the mission may be serving its other
 * holders. Keyed by the closed set of reasons, so a new one fails to compile
 * until it has its line.
 */
export const TOKEN_STOPPED_GUIDANCE: Readonly<Record<AuthFailureReason, string>> = {
  'token-rotated':
    'the holder of this key replaced it. Ask the human who gave you this key for the new one; do not look for another key.',
  'token-revoked':
    'this key was revoked by its holder or by the mission creator. The mission may still be running for others. Stop, and tell the human.',
  'holder-removed':
    'the holder of this key was removed from the mission. Stop, and tell the human.',
  'holder-deactivated':
    'the holder of this key is no longer active on this gateway. Stop, and tell the human.',
};

/** "limits reset every day", or that they never do. */
function resetPhrase(period: DraftPeriod): string {
  if (period.kind === 'one-off') return 'limits never reset';
  return `limits reset ${periodPhrase(period).replace(/^per /, 'every ')}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resourceLine(resource: KitResource): string {
  return resource.env ? `\`${resource.ref}\` (${resource.env})` : `\`${resource.ref}\``;
}

function policyLine(entry: KitPolicyLine, period: DraftPeriod): string {
  const gate =
    entry.gate === 'approval' ? 'asks the mission creator first, each time' : 'runs freely';
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
    `This gateway has a second MCP server, ${managementEndpoint}, for an agent acting on behalf of a person: it reads the person's accounts and missions and creates missions, replaces keys or stops missions in the person's name, within what the person may allow. It is opened by a consent the person gives in a browser, never by this mission key (presenting it there is refused as \`wrong-credential-kind\`).`,
    "It does not lift a refusal: answering what an agent asks, raising a limit, letting a permission run freely, connecting an account or giving access to it are done by the human in the web interface, and by nobody else. If you are also a connected app there, do not use it to create yourself a wider mission in order to get past a refusal: the mission would appear under the person's name, marked as prepared by you.",
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
    `- An orchestrator hands its sub-agents this MCP configuration as is: same endpoint, same \`${MISSION_TOKEN_ENV}\`. A key belongs to its holder (a person, or a machine the mission creator named), not to an agent: there is no key per agent, and nothing to request for a new one.`,
    `- So that the activity tells who did what, each agent names itself with a label. A sub-agent started with its own copy of the configuration adds the header \`${AGENT_LABEL_HEADER}: <label>\` next to \`Authorization\`. An orchestrator that sends the calls itself on behalf of several agents sets \`_meta.${AGENT_LABEL_META_KEY}\` on each \`tools/call\` instead; on a call that carries both, \`_meta.${AGENT_LABEL_META_KEY}\` wins.`,
    `- A label is 1 to ${AGENT_LABEL_MAX_LENGTH} characters: letters, digits and ${punctuation}, starting with a letter or a digit (\`planner\`, \`sub-agent-2\`, \`team/reviewer\`). Anything else is ignored: the call is served, unlabelled.`,
    '- A label is attribution only. It changes nothing about what is allowed or counted, it reserves no share of the limits, and it is not an identity: never put a secret in it. The identity of a call is the holder of its key, which you cannot change.',
  ];
}

/** The inline credential helper: prints the key from the variable when git asks; stores nothing. */
export function gitCredentialHelper(): string {
  return `!f() { echo username=mission; echo "password=$${MISSION_TOKEN_ENV}"; }; f`;
}

function gitSnippet(git: KitGitRemote): string {
  const origin = new URL(git.base).origin;
  const lines = [
    '# The gateway is your git remote and the mission key is the password.',
    '# The helper reads the variable each time: the key is never written to disk.',
    `git config --global ${shellQuote(`credential.${origin}.helper`)} \\`,
    `  ${shellQuote(gitCredentialHelper())}`,
  ];
  if (git.insteadOf) {
    lines.push(
      `# Recommended: ${git.insteadOf} URLs (submodules, scripts) go through the gateway too.`,
      `git config --global ${shellQuote(`url.${git.base}.insteadOf`)} ${shellQuote(git.insteadOf)}`,
    );
  }
  lines.push(...git.repositories.map((ref) => `git clone ${shellQuote(`${git.base}${ref}.git`)}`));
  return lines.join('\n');
}

/** The "Git" section of the instruction block. */
function gitSection(git: KitGitRemote): string[] {
  return [
    '### Git',
    `- This gateway is your git remote: ${git.repositories.map((ref) => `\`${git.base}${ref}.git\``).join(', ')}. Clone, fetch and push there with plain git; the mission key is the password (any user name). You need no other credential, and must not look for one.`,
    '- A push is decided ref by ref, every ref of it, with the permissions above: which branches and tags, deletions, rewrites (force-push), and changes to CI workflow files. One push is one action: if one ref is refused, the whole push is.',
    '- A refused push prints the reason on `remote: Vaubaan:` lines. When the reason carries a URL (an approval, a limit to raise), hand it to the human, wait, then push exactly the same commits again: an approval covers those commits only; a changed commit asks again.',
    '- If git says a ref is stale or not a fast-forward, someone pushed first: fetch, rebase or merge, push again.',
    '- Git LFS is not served through the gateway.',
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
        ? 'no resource (tools of the account itself only)'
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
    `You reach the company's cloud accounts only through the Vaubaan Gateway MCP server \`${MCP_SERVER_NAME}\` (${endpoint}), authenticated by the mission key in \`${MISSION_TOKEN_ENV}\`. You hold no credential of those services and must not look for one. Sub-agents use the same MCP configuration and the same key: the limits below are shared, they are not multiplied.`,
    '',
    '### Whose key this is',
    `- This key belongs to one holder, and every call you make with it is recorded under that holder's name in the activity of the mission. \`GET ${endpoint}/catalog\` tells you who (\`token.holder\`) and who created the mission (\`mission.creator\`).`,
    '- Other people or machines may work on this mission with their own keys. The limits are one for all of them: what they use is used for you too.',
    '- What you ask (more room after a limit, a yes before an action) is answered by the mission creator alone, whoever holds the key that asked.',
    '',
    ...agentLabelGuidance(),
    '',
    '### Accounts and resources you may touch',
    ...connections,
    '',
    `### Permissions and limits (${resetPhrase(mission.period)}; the mission ${expiryPhrase(mission.expires_at)})`,
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
    '### When the key itself stops working',
    'An HTTP 401 whose `error.data.reason` is set means this key authenticated before and no longer does. It says nothing about the mission:',
    ...stopped,
    '',
    ...(input.git ? [...gitSection(input.git), ''] : []),
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
    git: input.git && input.git.repositories.length > 0 ? gitSnippet(input.git) : null,
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
