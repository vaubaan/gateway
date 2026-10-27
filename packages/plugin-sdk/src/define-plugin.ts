/**
 * `definePlugin` — validate a plugin definition once, at module load.
 *
 * ADR : docs/decisions/plugin-contract-and-credential-spec.md.
 *
 * A plugin that passes `definePlugin` is well-formed by construction : id
 * grammar, semver, tool prefixes, catalog provider, data-model integrity,
 * presets, credential spec. The registry repeats nothing of this ; it only
 * checks what spans several plugins (unique ids, unique tool names).
 */

import {
  CREDENTIAL_KINDS,
  isCredentialKind,
  isProviderId,
  toolPrefixFor,
  validateDataModel,
} from '@vaubaan/shared';
import { baseRiskId, isRiskId } from '@vaubaan/shared/risk-id';

import { semanticIssues } from './catalog-loader.ts';
import {
  BROKER_PROVIDER_PATTERN,
  OAUTH2_REVOCATION_FORMATS,
  TOKEN_PERMISSION_ACCESS,
  type CredentialSpec,
  type OAuth2CredentialSpec,
  type OAuth2RegisteredClientSpec,
} from './credential.ts';
import type { ProviderPlugin } from './plugin.ts';

/** Semver 2.0, pre-release allowed, no build metadata. */
export const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Upper bound of `ProviderPlugin.summary` : a paragraph, not a handbook. */
export const PLUGIN_SUMMARY_MAX_LENGTH = 600;

/**
 * `ProviderPlugin.icon` : the `d` attribute of one SVG path — a drawing
 * command first, then commands, numbers and separators only. No markup, no
 * `url(…)`, nothing a page could not put inside `<path d="…">` as it is.
 */
export const SVG_PATH_DATA_PATTERN = /^[Mm][0-9A-Za-z.,\s+-]*$/;

/** `ProviderPlugin.iconColor` : one sRGB colour as six hex digits, `#RRGGBB`, nothing a stylesheet could misread. */
export const HEX_COLOUR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** Upper bound of one `ProviderPlugin.toolTitles` entry : a headline, not a description. */
export const TOOL_TITLE_MAX_LENGTH = 60;

export class PluginDefinitionError extends Error {
  constructor(
    readonly pluginId: string,
    readonly issues: readonly string[],
  ) {
    super(`Invalid plugin definition '${pluginId}':\n  - ${issues.join('\n  - ')}`);
    this.name = 'PluginDefinitionError';
  }
}

/** Every issue with a definition. Empty array = well-formed. Pure. */
export function pluginIssues(plugin: ProviderPlugin): string[] {
  return [
    ...identityIssues(plugin),
    ...toolIssues(plugin),
    ...toolTitleIssues(plugin),
    ...secretArgumentIssues(plugin),
    ...dataModelIssues(plugin),
    ...catalogIssues(plugin),
    ...credentialSpecIssues(plugin),
    ...hookIssues(plugin),
    ...tokenHandoutIssues(plugin),
    ...resourceCreatingToolIssues(plugin),
    ...gitRemoteIssues(plugin),
    ...toolReasonIssues(plugin.unboundTools, declaredToolNames(plugin), 'unboundTools'),
  ];
}

/** Every tool name a plugin answers for : its MCP tools and the two tools of its git remote. */
export function declaredToolNames(
  plugin: Pick<ProviderPlugin, 'tools' | 'gitRemote'>,
): Set<string> {
  const names = new Set<string>(isList(plugin.tools) ? plugin.tools.map((t) => t?.name) : []);
  if (plugin.gitRemote) {
    names.add(plugin.gitRemote.fetchTool);
    names.add(plugin.gitRemote.pushTool);
  }
  return names;
}

/**
 * The git remote's two tools carry the plugin's prefix, are distinct, and are
 * NOT MCP tools : listed in `tools`, an agent could call the push tool with
 * arguments of its own instead of the host's review.
 */
function gitRemoteIssues(plugin: ProviderPlugin): string[] {
  const remote: unknown = plugin.gitRemote;
  if (remote === undefined) return [];
  if (!isRecord(remote)) return ['gitRemote: expected an object when present'];
  const issues: string[] = [];
  const prefix = typeof plugin.id === 'string' ? toolPrefixFor(plugin.id) : '';
  const mcp = new Set(isList(plugin.tools) ? plugin.tools.map((t) => t?.name) : []);
  for (const key of ['fetchTool', 'pushTool'] as const) {
    const name = remote[key];
    if (typeof name !== 'string' || !name.startsWith(prefix) || name.length === prefix.length) {
      issues.push(`gitRemote.${key} must be a tool name starting with '${prefix}'`);
      continue;
    }
    if (mcp.has(name)) issues.push(`gitRemote.${key} '${name}' must not be an MCP tool`);
  }
  if (remote.fetchTool === remote.pushTool) {
    issues.push('gitRemote.fetchTool and gitRemote.pushTool must differ');
  }
  for (const fn of ['repositoryOf', 'upstream', 'review'] as const) {
    if (typeof remote[fn] !== 'function') issues.push(`gitRemote.${fn}: expected a function`);
  }
  const risks = new Set((plugin.catalog?.risks ?? []).map((r) => r.id));
  if (typeof remote.pushRisk !== 'string' || !risks.has(remote.pushRisk)) {
    issues.push(`gitRemote.pushRisk '${String(remote.pushRisk)}' is not a risk of the catalog`);
  }
  const abilities: unknown = remote.abilities;
  if (abilities !== undefined) {
    if (!isList(abilities)) issues.push('gitRemote.abilities: expected a list when present');
    else
      abilities.forEach((ability, i) => {
        if (!isRecord(ability) || typeof ability.words !== 'string' || ability.words === '') {
          issues.push(`gitRemote.abilities[${i}]: expected { risk_id, words }`);
        } else if (typeof ability.risk_id !== 'string' || !risks.has(ability.risk_id)) {
          issues.push(
            `gitRemote.abilities[${i}].risk_id '${String(ability.risk_id)}' is not a risk of the catalog`,
          );
        }
      });
  }
  return issues;
}

/** A handout names a declared tool and risks of the plugin's own catalog. */
function tokenHandoutIssues(plugin: ProviderPlugin): string[] {
  const handouts: unknown = plugin.tokenHandouts;
  if (handouts === undefined) return [];
  if (!isList(handouts)) return ['tokenHandouts: expected a list when present'];
  const tools = new Set(isList(plugin.tools) ? plugin.tools.map((t) => t?.name) : []);
  const risks = new Set((plugin.catalog?.risks ?? []).map((r) => r.id));
  const issues: string[] = [];
  handouts.forEach((handout, i) => {
    if (!isRecord(handout) || typeof handout.tool !== 'string' || !isList(handout.riskIds)) {
      issues.push(`tokenHandouts[${i}]: expected { tool, riskIds }`);
      return;
    }
    if (!tools.has(handout.tool)) {
      issues.push(`tokenHandouts[${i}].tool '${handout.tool}' is not a tool of this plugin`);
    }
    if (handout.riskIds.length === 0) {
      issues.push(`tokenHandouts[${i}].riskIds: expected at least one risk`);
    }
    for (const riskId of handout.riskIds) {
      if (typeof riskId !== 'string' || !risks.has(riskId)) {
        issues.push(
          `tokenHandouts[${i}].riskIds: '${String(riskId)}' is not a risk of the catalog`,
        );
      }
    }
    const readOnly: unknown = handout.readOnlyRiskIds;
    if (readOnly === undefined) return;
    if (!isList(readOnly)) {
      issues.push(`tokenHandouts[${i}].readOnlyRiskIds: expected a list when present`);
      return;
    }
    for (const riskId of readOnly) {
      if (typeof riskId !== 'string' || !handout.riskIds.includes(riskId)) {
        issues.push(
          `tokenHandouts[${i}].readOnlyRiskIds: '${String(riskId)}' is not one of its riskIds`,
        );
      }
    }
  });
  return [...issues, ...handoutGateIssues(plugin)];
}

/**
 * The risks whose call hands the agent a token that can write at the provider :
 * every handout risk the plugin did not declare read-only. Unqualified ids.
 */
export function writeHandoutRiskIds(plugin: Pick<ProviderPlugin, 'tokenHandouts'>): Set<string> {
  const write = new Set<string>();
  const handouts: unknown = plugin.tokenHandouts;
  if (!isList(handouts)) return write;
  for (const handout of handouts) {
    if (!isRecord(handout) || !isList(handout.riskIds)) continue;
    const readOnly = new Set(isList(handout.readOnlyRiskIds) ? handout.readOnlyRiskIds : []);
    for (const riskId of handout.riskIds) {
      if (typeof riskId === 'string' && !readOnly.has(riskId)) write.add(riskId);
    }
  }
  return write;
}

/**
 * Spec §2.4 : a preset that carries a token-handing risk which grants write gates
 * it by approval. A preset is what a creator accepts in one click ; a token that
 * writes outside the gateway is not handed on a click.
 */
function handoutGateIssues(plugin: ProviderPlugin): string[] {
  const write = writeHandoutRiskIds(plugin);
  if (write.size === 0) return [];
  const issues: string[] = [];
  for (const preset of plugin.catalog?.presets ?? []) {
    for (const entry of preset.entries ?? []) {
      if (typeof entry?.risk_id !== 'string' || !isRiskId(entry.risk_id)) continue;
      if (!write.has(baseRiskId(entry.risk_id)) || entry.gate === 'approval') continue;
      issues.push(
        `catalog: preset '${preset.id}': '${entry.risk_id}' hands the agent a token that can write ; its gate must be 'approval' (declare it in tokenHandouts.readOnlyRiskIds if the token is read-only)`,
      );
    }
  }
  return issues;
}

function identityIssues(plugin: ProviderPlugin): string[] {
  const issues: string[] = [];
  if (typeof plugin.id !== 'string' || !isProviderId(plugin.id)) {
    issues.push(`id: expected a lowercase slug such as 'github' or 'cloudflare-dns'`);
  }
  if (typeof plugin.displayName !== 'string' || plugin.displayName.trim().length === 0) {
    issues.push('displayName: expected a non-empty string');
  }
  if (typeof plugin.version !== 'string' || !PLUGIN_VERSION_PATTERN.test(plugin.version)) {
    issues.push(`version: expected semver (MAJOR.MINOR.PATCH), got '${String(plugin.version)}'`);
  }
  if (plugin.icon !== undefined) {
    if (typeof plugin.icon !== 'string' || !SVG_PATH_DATA_PATTERN.test(plugin.icon)) {
      issues.push('icon: expected the path data of one SVG path (`M…`) when present');
    }
  }
  if (plugin.iconColor !== undefined) {
    if (typeof plugin.iconColor !== 'string' || !HEX_COLOUR_PATTERN.test(plugin.iconColor)) {
      issues.push('iconColor: expected a colour as `#RRGGBB` when present');
    }
  }
  if (plugin.summary !== undefined) {
    if (typeof plugin.summary !== 'string' || plugin.summary.trim().length === 0) {
      issues.push('summary: expected a non-empty string when present');
    } else if (plugin.summary.length > PLUGIN_SUMMARY_MAX_LENGTH) {
      issues.push(`summary: expected at most ${PLUGIN_SUMMARY_MAX_LENGTH} characters`);
    }
  }
  if (plugin.manualRevocation !== undefined) {
    if (typeof plugin.manualRevocation !== 'string' || plugin.manualRevocation.trim() === '') {
      issues.push('manualRevocation: expected a non-empty string when present');
    } else if (plugin.manualRevocation.length > PLUGIN_MANUAL_REVOCATION_MAX_LENGTH) {
      issues.push(
        `manualRevocation: expected at most ${PLUGIN_MANUAL_REVOCATION_MAX_LENGTH} characters`,
      );
    }
  }
  if (plugin.revoke !== undefined && typeof plugin.revoke !== 'function') {
    issues.push('revoke: expected a function when present');
  }
  return issues;
}

/** Upper bound of `ProviderPlugin.manualRevocation` : a sentence or two. */
export const PLUGIN_MANUAL_REVOCATION_MAX_LENGTH = 400;

function registrationIssues(spec: OAuth2RegisteredClientSpec): string[] {
  const registration: unknown = spec.clientRegistration;
  if (!isRecord(registration))
    return ['credential.clientRegistration: expected { registrationUrl }'];
  const issues: string[] = [];
  if (!isHttpsUrl(registration.registrationUrl)) {
    issues.push('credential.clientRegistration.registrationUrl: expected an https URL');
  }
  return issues;
}

function revocationIssues(spec: OAuth2RegisteredClientSpec): string[] {
  const revocation: unknown = spec.revocation;
  if (!isRecord(revocation)) return ['credential.revocation: expected { url, format }'];
  const issues: string[] = [];
  if (!isHttpsUrl(revocation.url)) issues.push('credential.revocation.url: expected an https URL');
  if (!(OAUTH2_REVOCATION_FORMATS as readonly unknown[]).includes(revocation.format)) {
    issues.push(
      `credential.revocation.format: expected one of ${OAUTH2_REVOCATION_FORMATS.join(' | ')}`,
    );
  }
  if (
    revocation.format === 'client-credentials-json' &&
    (spec.clientAuthMethod === 'none' || !spec.refreshable)
  ) {
    issues.push(
      "credential.revocation.format: 'client-credentials-json' needs a confidential client and refresh tokens",
    );
  }
  return issues;
}

function toolIssues(plugin: ProviderPlugin): string[] {
  if (!isList(plugin.tools)) return ['tools: expected a list of McpToolDeclaration'];
  if (typeof plugin.id !== 'string') return [];
  const issues: string[] = [];
  const prefix = toolPrefixFor(plugin.id);
  const seen = new Set<string>();
  plugin.tools.forEach((tool: unknown, i) => {
    // A definition may come from untyped code : a malformed entry is an
    // issue like any other, not a TypeError that hides the rest.
    if (!isRecord(tool) || typeof tool.name !== 'string') {
      issues.push(`tools[${i}].name: expected a string`);
      return;
    }
    const name = tool.name;
    if (!name.startsWith(prefix) || name.length === prefix.length) {
      issues.push(`tools[${i}].name '${name}' must start with '${prefix}'`);
    }
    if (seen.has(name)) issues.push(`tools[${i}].name '${name}' is declared twice`);
    seen.add(name);
    if (!isRecord(tool.inputSchema) || tool.inputSchema.type !== 'object')
      issues.push(`tools[${i}].inputSchema.type must be 'object'`);
  });
  return issues;
}

/**
 * `resourceCreatingTools` names MCP tools of the plugin, once each : the host
 * runs discovery after a successful call of one of them, so a name that is not
 * a tool would silently trigger nothing. A plugin that declares it reads the
 * created resource from the answer (`createdResources`).
 */
function resourceCreatingToolIssues(plugin: ProviderPlugin): string[] {
  const declared: unknown = plugin.resourceCreatingTools;
  const reader: unknown = plugin.createdResources;
  if (reader !== undefined && typeof reader !== 'function') {
    return ['createdResources: expected a function when present'];
  }
  if (declared === undefined) return [];
  if (!isList(declared) || declared.length === 0) {
    return ['resourceCreatingTools: expected a non-empty list of tool names when present'];
  }
  const mcp = new Set(isList(plugin.tools) ? plugin.tools.map((t) => t?.name) : []);
  const issues: string[] = [];
  // The host adds what a creating call made to the mission that made it, read
  // from the call's answer (ADR created-resources-join-the-mission).
  if (reader === undefined) {
    issues.push(
      'createdResources: required when resourceCreatingTools is declared (read the created resource from the answer)',
    );
  }
  const seen = new Set<unknown>();
  for (const tool of declared) {
    if (typeof tool !== 'string' || !mcp.has(tool)) {
      issues.push(`resourceCreatingTools: '${String(tool)}' is not a tool of this plugin`);
    } else if (seen.has(tool)) {
      issues.push(`resourceCreatingTools: '${tool}' is listed twice`);
    }
    seen.add(tool);
  }
  return issues;
}

/**
 * `secretArguments` names declared tools and, for each, arguments its input
 * schema declares : a masked name that is not an argument would mask nothing.
 */
function secretArgumentIssues(plugin: ProviderPlugin): string[] {
  const masks: unknown = plugin.secretArguments;
  if (masks === undefined) return [];
  if (!isRecord(masks))
    return ['secretArguments: expected an object keyed by tool name when present'];
  const issues: string[] = [];
  const tools = isList(plugin.tools) ? plugin.tools : [];
  for (const [tool, names] of Object.entries(masks)) {
    const declared = tools.find((t) => t?.name === tool);
    if (!declared) {
      issues.push(`secretArguments['${tool}'] is not a tool of this plugin`);
      continue;
    }
    if (!Array.isArray(names) || names.length === 0) {
      issues.push(`secretArguments['${tool}']: expected a non-empty list of argument names`);
      continue;
    }
    const properties = declared.inputSchema.properties ?? {};
    for (const name of names) {
      if (typeof name !== 'string' || !Object.hasOwn(properties, name)) {
        issues.push(`secretArguments['${tool}']: '${String(name)}' is not an argument of the tool`);
      }
    }
  }
  return issues;
}

/**
 * A title names a declared tool and reads as a headline : a few words, sentence
 * case, no final period. Which tools have one is the plugin's choice.
 */
function toolTitleIssues(plugin: ProviderPlugin): string[] {
  const titles: unknown = plugin.toolTitles;
  if (titles === undefined) return [];
  if (!isRecord(titles)) return ['toolTitles: expected an object keyed by tool name when present'];
  const tools = declaredToolNames(plugin);
  const issues: string[] = [];
  for (const [tool, title] of Object.entries(titles)) {
    if (!tools.has(tool)) issues.push(`toolTitles['${tool}'] is not a tool of this plugin`);
    if (typeof title !== 'string' || title.trim().length === 0) {
      issues.push(`toolTitles['${tool}']: expected a non-empty string`);
      continue;
    }
    if (title !== title.trim() || /\s{2,}|[\r\n]/.test(title)) {
      issues.push(`toolTitles['${tool}']: expected a single line without surrounding spaces`);
    }
    if (title.length > TOOL_TITLE_MAX_LENGTH) {
      issues.push(`toolTitles['${tool}']: expected at most ${TOOL_TITLE_MAX_LENGTH} characters`);
    }
    if (/[.!]$/.test(title)) issues.push(`toolTitles['${tool}']: a title has no final period`);
    if (!/^[A-Z]/.test(title)) {
      issues.push(`toolTitles['${tool}']: a title starts with a capital letter`);
    }
  }
  return issues;
}

function dataModelIssues(plugin: ProviderPlugin): string[] {
  if (!plugin.dataModel || typeof plugin.dataModel !== 'object') return ['dataModel: missing'];
  const issues: string[] = [];
  if (plugin.dataModel.provider !== plugin.id) {
    issues.push(`dataModel.provider '${plugin.dataModel.provider}' must equal the plugin id`);
  }
  issues.push(...validateDataModel(plugin.dataModel).map((m) => `dataModel: ${m}`));
  return issues;
}

/**
 * The catalog rules of `semanticIssues` — fallback, wildcards, presets and
 * their budgets. This is the only validation a catalog written in
 * TypeScript goes through, so everything that must hold for every catalog
 * lives there, not in the YAML parser.
 */
function catalogIssues(plugin: ProviderPlugin): string[] {
  if (!plugin.catalog || typeof plugin.catalog !== 'object') {
    return ['catalog: missing — load it with loadCatalogFile(catalogPathNextTo(import.meta.url))'];
  }
  const issues: string[] = [];
  if (plugin.catalog.provider !== plugin.id) {
    issues.push(`catalog.provider '${plugin.catalog.provider}' must equal the plugin id`);
  }
  issues.push(...semanticIssues(plugin.catalog).map((m) => `catalog: ${m}`));
  return issues;
}

function hookIssues(plugin: ProviderPlugin): string[] {
  const issues: string[] = [];
  for (const fn of ['classify', 'execute', 'discoverResources'] as const) {
    if (typeof plugin[fn] !== 'function') issues.push(`${fn}: expected a function`);
  }
  for (const fn of ['envOf', 'refresh', 'normalizeForCaps', 'normalizeArgs'] as const) {
    if (plugin[fn] !== undefined && typeof plugin[fn] !== 'function')
      issues.push(`${fn}: expected a function when present`);
  }
  return issues;
}

/** Upper bound of one guide step. */
export const CREDENTIAL_SENTENCE_MAX_LENGTH = 300;

function credentialSpecIssues(plugin: ProviderPlugin): string[] {
  const at = 'credential';
  const spec = plugin.credential;
  const issues = kindSpecIssues(spec);
  if (!isRecord(spec) || typeof spec.kind !== 'string') return issues;
  // The git remote's tools need permissions on a token too.
  const tools = declaredToolNames(plugin);
  if (spec.kind === 'api-key') {
    if (spec.label !== undefined && !isSentence(spec.label, CREDENTIAL_SENTENCE_MAX_LENGTH)) {
      issues.push(`${at}.label: expected a short name when present`);
    }
    if (spec.verify !== undefined && typeof spec.verify !== 'function') {
      issues.push(`${at}.verify: expected a function when present`);
    }
    if (spec.createUrl !== undefined && !isHttpsUrl(spec.createUrl)) {
      issues.push(`${at}.createUrl: expected an https URL when present`);
    }
    if (spec.guide !== undefined) {
      issues.push(...guideIssues(spec.guide, tools, `${at}.guide`));
    }
  }
  return issues;
}

/** A record tool → one sentence (`unboundTools`): every key a tool of the plugin. */
function toolReasonIssues(reasons: unknown, tools: ReadonlySet<unknown>, label: string): string[] {
  if (reasons === undefined) return [];
  if (!isRecord(reasons)) return [`${label}: expected a record tool → reason`];
  const issues: string[] = [];
  for (const [tool, reason] of Object.entries(reasons)) {
    if (!tools.has(tool)) issues.push(`${label}: '${tool}' is not a tool of this plugin`);
    if (!isSentence(reason, CREDENTIAL_SENTENCE_MAX_LENGTH)) {
      issues.push(`${label}.${tool}: expected one sentence saying why`);
    }
  }
  return issues;
}

/**
 * A guide lists real tools, in the closed access set, and covers every tool
 * this way of connecting can run: the page derives the permissions to tick
 * from it, so a tool nobody asked a permission for would fail at the provider.
 */
function guideIssues(guide: unknown, tools: ReadonlySet<unknown>, at: string): string[] {
  if (!isRecord(guide)) return [`${at}: expected { steps, permissions, recommendedExpiryDays }`];
  const issues: string[] = [];
  if (!isList(guide.steps) || guide.steps.length === 0) {
    issues.push(`${at}.steps: expected at least one step`);
  } else if (!guide.steps.every((step) => isSentence(step, CREDENTIAL_SENTENCE_MAX_LENGTH))) {
    issues.push(`${at}.steps: every step is one plain sentence`);
  }
  const days = guide.recommendedExpiryDays;
  if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1)) {
    issues.push(`${at}.recommendedExpiryDays: expected a positive number of days or null`);
  }
  if (guide.docsUrl !== undefined && !isHttpsUrl(guide.docsUrl)) {
    issues.push(`${at}.docsUrl: expected an https URL when present`);
  }
  if (!isList(guide.permissions)) {
    return [
      ...issues,
      `${at}.permissions: expected a list (empty when the token carries no choice)`,
    ];
  }
  // A provider whose tokens carry no permission choice (Railway) lists none.
  if (guide.permissions.length === 0) return issues;
  const served = new Set<unknown>();
  guide.permissions.forEach((permission, i) => {
    const where = `${at}.permissions[${i}]`;
    if (!isRecord(permission)) {
      issues.push(`${where}: expected { name, access, tools }`);
      return;
    }
    if (!isName(permission.name)) issues.push(`${where}.name: expected the provider's name`);
    if (!(TOKEN_PERMISSION_ACCESS as readonly unknown[]).includes(permission.access)) {
      issues.push(`${where}.access: expected one of ${TOKEN_PERMISSION_ACCESS.join(' | ')}`);
    }
    if (!isList(permission.tools) || permission.tools.length === 0) {
      issues.push(`${where}.tools: expected at least one tool`);
      return;
    }
    for (const tool of permission.tools) {
      if (!tools.has(tool))
        issues.push(`${where}.tools: '${String(tool)}' is not a tool of this plugin`);
      served.add(tool);
    }
  });
  for (const tool of tools) {
    if (typeof tool === 'string' && !served.has(tool)) {
      issues.push(`${at}.permissions: no permission serves '${tool}'`);
    }
  }
  return issues;
}

function isSentence(x: unknown, max: number): x is string {
  return typeof x === 'string' && x.trim().length > 0 && x.length <= max;
}

function kindSpecIssues(spec: CredentialSpec): string[] {
  if (!spec || typeof spec !== 'object') return ['credential: missing CredentialSpec'];
  if (typeof spec.kind !== 'string' || !isCredentialKind(spec.kind)) {
    return [`credential.kind: expected one of ${CREDENTIAL_KINDS.join(' | ')}`];
  }
  const issues: string[] = [];
  switch (spec.kind) {
    case 'api-key':
      if (!isList(spec.fields) || spec.fields.length === 0)
        issues.push('credential.fields: expected at least one field');
      else if (!spec.fields.some((f) => f.secret))
        issues.push('credential.fields: an api-key spec needs at least one secret field');
      break;
    case 'oauth2':
      issues.push(...oauth2Issues(spec));
      break;
    case 'ssh-key':
      if (spec.algorithm !== 'ed25519')
        issues.push("credential.algorithm: only 'ed25519' is supported");
      if (!Array.isArray(spec.fields))
        issues.push('credential.fields: expected a list (host, port, user)');
      break;
  }
  return issues;
}

/**
 * Fields only a spec with a registered client carries: a brokered spec leaves
 * the provider's endpoints, PKCE, the client authentication and the
 * revocation to the broker.
 */
const REGISTERED_CLIENT_ONLY_FIELDS = [
  'authorizationUrl',
  'tokenUrl',
  'pkce',
  'resourceIndicator',
  'clientAuthMethod',
  'refreshable',
  'extraAuthorizationParams',
  'revocation',
] as const;

/**
 * An `oauth2` spec declares exactly one client source (ADR
 * google-calendar-through-an-oauth-broker D3): `clientRegistration` (the gateway
 * registers itself) or `broker` (the client is an OAuth broker's).
 */
function oauth2Issues(spec: OAuth2CredentialSpec): string[] {
  const record = spec as unknown as Record<string, unknown>;
  const hasBroker = record.broker !== undefined;
  const hasRegistration = record.clientRegistration !== undefined;
  if (hasBroker && hasRegistration) {
    return ['credential: declare one client source, clientRegistration or broker, not both'];
  }
  const issues: string[] = [];
  if (!Array.isArray(spec.scopes)) issues.push('credential.scopes: expected a list (may be empty)');
  if (hasBroker) {
    const broker: unknown = record.broker;
    if (
      !isRecord(broker) ||
      typeof broker.provider !== 'string' ||
      !BROKER_PROVIDER_PATTERN.test(broker.provider)
    ) {
      issues.push(
        "credential.broker: expected { provider } with a lowercase slug such as 'google'",
      );
    }
    for (const field of REGISTERED_CLIENT_ONLY_FIELDS) {
      if (record[field] !== undefined) {
        issues.push(`credential.${field}: a brokered spec leaves it to the broker`);
      }
    }
    return issues;
  }
  return [...issues, ...registeredClientIssues(spec as OAuth2RegisteredClientSpec)];
}

function registeredClientIssues(spec: OAuth2RegisteredClientSpec): string[] {
  const issues: string[] = [];
  for (const key of ['authorizationUrl', 'tokenUrl'] as const) {
    if (!isHttpsUrl(spec[key])) issues.push(`credential.${key}: expected an https URL`);
  }
  if (spec.clientAuthMethod === 'none' && !spec.pkce)
    issues.push('credential.pkce: a public client (clientAuthMethod none) must use PKCE');
  if (spec.revocation !== undefined) issues.push(...revocationIssues(spec));
  // Without a broker, the only OAuth client the host knows is one it registers
  // itself (ADR gmail-over-imap-with-an-app-password): no administrator declares one.
  issues.push(...registrationIssues(spec));
  // `refreshable: true` needs no `refresh()` : the host performs the standard
  // refresh_token grant from the spec (ADR plugin-contract D2 as amended) ;
  // `refresh` is an override for non-standard flows.
  return issues;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isName(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

/** `Array.isArray` narrows a readonly array to `any[]` ; this guard keeps the element type. */
function isList(x: unknown): x is readonly unknown[] {
  return Array.isArray(x);
}

function isHttpsUrl(x: unknown): boolean {
  if (typeof x !== 'string') return false;
  try {
    return new URL(x).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate and freeze a plugin definition. Throws `PluginDefinitionError`
 * with every issue, so a broken plugin fails at import time, not at the
 * first call.
 */
export function definePlugin<P extends ProviderPlugin>(definition: P): P {
  const issues = pluginIssues(definition);
  if (issues.length > 0) throw new PluginDefinitionError(String(definition.id), issues);
  return Object.freeze(definition);
}
