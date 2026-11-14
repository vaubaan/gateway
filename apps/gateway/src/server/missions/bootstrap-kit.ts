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
 *      token itself stops working, and a short "missions prepared by an agent" section — what the
 *      `vaubaan__*` tools do, and that they never lift a refusal;
 *   4. when the mission holds repositories of a provider the instance is a
 *      git remote of (spec §4.1 ter): git's configuration — a credential
 *      helper that reads the variable (never `store` or `cache`, never the
 *      key in a URL) and, per provider, the recommended `insteadOf` rewrite
 *      of its URLs to `<instance>/git/<provider>/` — and the remote of each
 *      repository;
 *   +  `curl … tools/list`.
 *
 * Pure: the instance URL comes from the configuration (`public_url`), nothing
 * is hard-coded but the path of the MCP door on this instance.
 */
import { AUTH_FAILURE_REASONS, type AuthFailureReason } from '@vaubaan/gateway-core';
import { REFUSAL_CODES, type MissionPolicyEntry, type RefusalCode } from '@vaubaan/shared';

import type { DraftPeriod } from '../../lib/missions/model';
import { expiryPhrase, periodPhrase } from '../../lib/missions/summary';
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
  /** What the mission reaches now. */
  readonly resources: readonly KitResource[];
  /** A set takes the resources that later appear in its environment. */
  readonly future?: boolean;
  /**
   * The connection's resource sets (risk model §4.7), only when it has several: each
   * with its label ("Resource set 1") and what it reaches. Absent with one set.
   */
  readonly resource_sets?: readonly KitResourceSet[];
}

export interface KitResourceSet {
  readonly label: string;
  readonly resources: readonly KitResource[];
  /** Resources that later appear in the set's environment join it. */
  readonly future: boolean;
}

export interface KitPolicyLine extends MissionPolicyEntry {
  readonly label: string;
  /** "Resource set 2", when its account has several sets; absent otherwise. */
  readonly resource_set?: string;
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
  /** The git remotes, one per provider whose repositories the mission holds; absent or empty: none. */
  readonly git?: readonly KitGitRemote[] | null;
}

/** The git remote of one provider. */
export interface KitGitRemote {
  /** `<public_url>/git/<provider>/`. */
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
    'the mission does not hold the permission for this action. Do not look for another way to obtain the same effect. If the assigned task requires these permissions, call `vaubaan__request_permission` with the returned `refusal_id` and a reason, then give `request_url` to the human and wait. Otherwise stop this action. Only the mission creator can enlarge the mission.',
  'budget-exhausted':
    'the limit of that permission is reached for the period. Stop that kind of action, hand `claim_url` to the human so the mission creator can reset or raise the limit, and continue with work that does not need it. Do not retry in a loop.',
  'approval-required':
    'the mission creator asked to be asked first for this action. Nothing was executed. Hand `approval_url` to the human, wait for their yes, then replay the call with exactly the same arguments; any change asks again.',
  'resource-not-in-mission':
    'the arguments cite a resource outside the mission. Use one of the refs listed above (`allowed_resources`), or ask the human to have the resource added.',
  'rate-limited':
    'too many actions on that permission in a short window. Wait `retry_after_seconds`, then retry once; nothing was counted against the limit.',
  'connection-unavailable':
    'the account behind this call needs reconnecting (its credential expired). Nothing you can do fixes it: tell the human who owns the account (`owner`).',
  'connection-revoked':
    'the account behind this call no longer serves this mission: it was removed (`final: true`, it never comes back), or the mission creator lost access to it (`final: false`, it serves again if the access is given back). The mission still works on its other accounts: keep using them. Do not retry through that account; tell the human, so the mission creator can issue a mission for the account that replaces it.',
  'mission-inactive':
    'the mission is expired, without an owner (`orphaned`: none of its accounts serves it any more) or stopped (`revoked`). Stop calling with this key and report to the human: a stopped mission needs a new one, an expired one more time, and one without an owner works again with this same key once its creator may allow its permissions again. A request opened before the mission lost its owner can be answered only until it expires; after that, your next refused call opens a new one.',
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

/** A connection issued whole: what it reaches now, and that later resources join. */
/** A list that takes future resources (ADR resource-set-is-one-environment-with-optional-future-resources). */
function withFuture(resources: readonly KitResource[]): string {
  const known = resources.length === 0 ? 'none known yet' : resources.map(resourceLine).join(', ');
  return `${known}; resources found later in the same environment join it.`;
}

/**
 * What a mission creates, it reaches (ADR created-resources-join-the-mission): said once,
 * under the accounts, whatever their scope.
 */
export const CREATED_RESOURCES_LINE =
  "A resource this mission creates through the gateway (a creating tool of the account, such as a new app, project or board) is reached right after its creation, from your next call on. One created elsewhere is not: the mission's creator adds it to the mission, or the account's owner refreshes its resources when the mission reaches the whole account; until then a call that cites it is refused with `resource-not-in-mission`.";

function policyLine(entry: KitPolicyLine, period: DraftPeriod): string {
  const gate =
    entry.gate === 'approval' ? 'asks the mission creator first, each time' : 'runs freely';
  const where = entry.resource_set ? ` (${entry.resource_set})` : '';
  return `- \`${entry.risk_id}\`${where} — ${entry.label}: ${entry.quota} ${periodPhrase(period)}, at most ${entry.rate_limit.max} per ${entry.rate_limit.window_seconds}s, ${gate}`;
}

/** What resource sets mean for the agent: said once, when an account has several. */
export const RESOURCE_SETS_LINE =
  'Where an account is split into resource sets, each set has its own permissions and limits. A call is judged by the set of the resource it names; a call that names no resource of the mission, or resources of several sets, must be allowed in each of those sets, asks first if any of them asks first, and counts against the limits of each.';

/** The sets of an account, one line each. */
function setLines(sets: readonly KitResourceSet[]): string[] {
  return sets.map((set) => {
    if (set.future) return `  - ${set.label}: ${withFuture(set.resources)}`;
    const resources =
      set.resources.length === 0 ? 'no resource' : set.resources.map(resourceLine).join(', ');
    return `  - ${set.label}: ${resources}`;
  });
}

/**
 * The "missions prepared by an agent" section of the instruction block (ADR
 * platform-management-is-a-plugin-on-the-execution-door): an executing agent
 * must know what the `vaubaan__*` tools are, and that nothing there lifts a
 * refusal.
 */
export function preparedMissionsSection(): string[] {
  return [
    '### Missions prepared by an agent',
    "When this mission holds a Vaubaan account, the `vaubaan__*` tools read the person's accounts and missions and create missions, replace keys or stop missions in the person's name, within what the person may allow and what this mission accepts. A mission you create there never holds a Vaubaan account, and this mission never replaces its own key or stops itself.",
    "They do not lift a refusal: answering what an agent asks, raising a limit, letting a permission run freely, connecting an account or giving access to it are done by the human in the web interface, and by nobody else. Do not create yourself a wider mission in order to get past a refusal: the mission would appear under the person's name, marked as prepared by this mission.",
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

function gitSnippet(remotes: readonly KitGitRemote[]): string {
  const origins = [...new Set(remotes.map((git) => new URL(git.base).origin))];
  const lines = [
    '# The gateway is your git remote and the mission key is the password.',
    '# The helper reads the variable each time: the key is never written to disk.',
    ...origins.flatMap((origin) => [
      `git config --global ${shellQuote(`credential.${origin}.helper`)} \\`,
      `  ${shellQuote(gitCredentialHelper())}`,
    ]),
  ];
  for (const git of remotes) {
    if (git.insteadOf) {
      lines.push(
        `# Recommended: ${git.insteadOf} URLs (submodules, scripts) go through the gateway too.`,
        `git config --global ${shellQuote(`url.${git.base}.insteadOf`)} ${shellQuote(git.insteadOf)}`,
      );
    }
  }
  for (const git of remotes) {
    lines.push(
      ...git.repositories.map((ref) => `git clone ${shellQuote(`${git.base}${ref}.git`)}`),
    );
  }
  return lines.join('\n');
}

/** The remotes that serve at least one repository of the mission. */
function servedRemotes(git: readonly KitGitRemote[] | null | undefined): readonly KitGitRemote[] {
  return (git ?? []).filter((remote) => remote.repositories.length > 0);
}

/** The "Git" section of the instruction block. */
function gitSection(remotes: readonly KitGitRemote[]): string[] {
  const urls = remotes.flatMap((git) => git.repositories.map((ref) => `\`${git.base}${ref}.git\``));
  return [
    '### Git',
    `- This gateway is your git remote: ${urls.join(', ')}. Clone, fetch and push there with plain git; the mission key is the password (any user name). You need no other credential, and must not look for one.`,
    '- A push is decided ref by ref, every ref of it, with the permissions above: which branches and tags, deletions, rewrites (force-push), and changes to CI workflow files. One push is one action: if one ref is refused, the whole push is.',
    '- A refused push prints the reason on `remote: Vaubaan:` lines. When the reason carries a URL (an approval, a limit to raise), hand it to the human, wait, then push exactly the same commits again: an approval covers those commits only; a changed commit asks again.',
    '- If git says a ref is stale or not a fast-forward, someone pushed first: fetch, rebase or merge, push again.',
    '- Git LFS is not served through the gateway.',
  ];
}

function agentInstructions(input: BootstrapKitInput, endpoint: string): string {
  const { mission } = input;
  const gitRemotes = servedRemotes(input.git);
  const connections = input.connections.flatMap((c) => {
    if (c.resource_sets && c.resource_sets.length > 1) {
      return [
        `- ${c.provider_label} "${c.display_name}" — in resource sets:`,
        ...setLines(c.resource_sets),
      ];
    }
    if (c.future) return `- ${c.provider_label} "${c.display_name}" — ${withFuture(c.resources)}`;
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
    CREATED_RESOURCES_LINE,
    ...(input.connections.some((c) => (c.resource_sets?.length ?? 0) > 1)
      ? [RESOURCE_SETS_LINE]
      : []),
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
    ...(gitRemotes.length > 0 ? [...gitSection(gitRemotes), ''] : []),
    ...preparedMissionsSection(),
  ].join('\n');
}

export function buildBootstrapKit(input: BootstrapKitInput): BootstrapKit {
  const instance = input.instanceUrl.replace(/\/+$/, '');
  const endpoint = `${instance}${EXECUTION_DOOR_PATH}`;
  const revealsSecret = 'secret' in input.token;
  const tokenValue = 'secret' in input.token ? input.token.secret : maskedToken(input.token.prefix);
  const gitRemotes = servedRemotes(input.git);

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
    git: gitRemotes.length > 0 ? gitSnippet(gitRemotes) : null,
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
