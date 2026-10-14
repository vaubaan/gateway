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
  CLIENT_ID_FIELD,
  CLIENT_SECRET_FIELD,
  isAppCredentialSpec,
  OAUTH2_REVOCATION_FORMATS,
  TOKEN_PERMISSION_ACCESS,
  type AppInstallCredentialSpec,
  type CredentialSpec,
  type OAuth2CredentialSpec,
} from './credential.ts';
import type { ProviderPlugin } from './plugin.ts';

/** Semver 2.0, pre-release allowed, no build metadata. */
export const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Upper bound of `ProviderPlugin.summary` : a paragraph, not a handbook. */
export const PLUGIN_SUMMARY_MAX_LENGTH = 600;

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
    ...dataModelIssues(plugin),
    ...catalogIssues(plugin),
    ...credentialSpecIssues(plugin),
    ...hookIssues(plugin),
    ...tokenHandoutIssues(plugin),
  ];
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

function revocationIssues(spec: OAuth2CredentialSpec): string[] {
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
 * A title names a declared tool and reads as a headline : a few words, sentence
 * case, no final period. Which tools have one is the plugin's choice.
 */
function toolTitleIssues(plugin: ProviderPlugin): string[] {
  const titles: unknown = plugin.toolTitles;
  if (titles === undefined) return [];
  if (!isRecord(titles)) return ['toolTitles: expected an object keyed by tool name when present'];
  const tools = new Set(isList(plugin.tools) ? plugin.tools.map((t) => t?.name) : []);
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

/** Upper bound of one `unavailableTools` reason and of one guide step. */
export const CREDENTIAL_SENTENCE_MAX_LENGTH = 300;

/**
 * The primary spec and every alternative, each checked alone (issues of an
 * alternative are prefixed `alternativeCredentials[i]`), then together: kinds
 * unique, at most one company app.
 */
function credentialSpecIssues(plugin: ProviderPlugin): string[] {
  const issues = [...oneSpecIssues(plugin, plugin.credential, 'credential')];
  const alternatives: unknown = plugin.alternativeCredentials;
  if (alternatives === undefined) return issues;
  if (!isList(alternatives))
    return [...issues, 'alternativeCredentials: expected a list when present'];
  alternatives.forEach((alt, i) => {
    issues.push(...oneSpecIssues(plugin, alt as CredentialSpec, `alternativeCredentials[${i}]`));
  });
  const specs = [plugin.credential, ...alternatives].filter(
    (s): s is CredentialSpec => isRecord(s) && typeof s.kind === 'string',
  );
  const kinds = specs.map((s) => s.kind);
  const repeated = kinds.filter((k, i) => kinds.indexOf(k) !== i);
  if (repeated.length > 0) {
    issues.push(`alternativeCredentials: kind '${repeated[0]}' is declared twice`);
  }
  if (specs.filter((s) => isAppCredentialSpec(s)).length > 1) {
    issues.push(
      'alternativeCredentials: at most one way of connecting may go through a company app',
    );
  }
  return issues;
}

function oneSpecIssues(plugin: ProviderPlugin, spec: CredentialSpec, at: string): string[] {
  const own = kindSpecIssues(spec);
  const issues = at === 'credential' ? own : own.map((i) => i.replace(/^credential/, at));
  if (!isRecord(spec) || typeof spec.kind !== 'string') return issues;
  const tools = new Set(isList(plugin.tools) ? plugin.tools.map((t) => t?.name) : []);
  issues.push(...unavailableToolsIssues(spec.unavailableTools, tools, at));
  if (
    spec.manualRevocation !== undefined &&
    !isSentence(spec.manualRevocation, PLUGIN_MANUAL_REVOCATION_MAX_LENGTH)
  ) {
    issues.push(`${at}.manualRevocation: expected one or two sentences when present`);
  }
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
      issues.push(...guideIssues(spec.guide, tools, spec.unavailableTools ?? {}, `${at}.guide`));
    }
  }
  return issues;
}

function unavailableToolsIssues(
  unavailable: unknown,
  tools: ReadonlySet<unknown>,
  at: string,
): string[] {
  if (unavailable === undefined) return [];
  if (!isRecord(unavailable)) return [`${at}.unavailableTools: expected a record tool → reason`];
  const issues: string[] = [];
  for (const [tool, reason] of Object.entries(unavailable)) {
    if (!tools.has(tool))
      issues.push(`${at}.unavailableTools: '${tool}' is not a tool of this plugin`);
    if (!isSentence(reason, CREDENTIAL_SENTENCE_MAX_LENGTH)) {
      issues.push(`${at}.unavailableTools.${tool}: expected one sentence saying why`);
    }
  }
  return issues;
}

/**
 * A guide lists real tools, in the closed access set, and covers every tool
 * this way of connecting can run: the page derives the permissions to tick
 * from it, so a tool nobody asked a permission for would fail at the provider.
 */
function guideIssues(
  guide: unknown,
  tools: ReadonlySet<unknown>,
  unavailable: Readonly<Record<string, string>>,
  at: string,
): string[] {
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
  if (!isList(guide.permissions) || guide.permissions.length === 0) {
    return [...issues, `${at}.permissions: expected at least one permission`];
  }
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
      else if (typeof tool === 'string' && tool in unavailable) {
        issues.push(`${where}.tools: '${tool}' is unavailable this way`);
      }
      served.add(tool);
    }
  });
  for (const tool of tools) {
    if (typeof tool === 'string' && !(tool in unavailable) && !served.has(tool)) {
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
      for (const key of ['authorizationUrl', 'tokenUrl'] as const) {
        if (!isHttpsUrl(spec[key])) issues.push(`credential.${key}: expected an https URL`);
      }
      if (!Array.isArray(spec.scopes))
        issues.push('credential.scopes: expected a list (may be empty)');
      if (spec.clientAuthMethod === 'none' && !spec.pkce)
        issues.push('credential.pkce: a public client (clientAuthMethod none) must use PKCE');
      if (spec.revocation !== undefined) issues.push(...revocationIssues(spec));
      // `refreshable: true` needs no `refresh()` : the host performs the
      // standard refresh_token grant from the spec (ADR plugin-contract D2 as
      // as amended) ; `refresh` is an override for non-standard flows.
      break;
    case 'app-install':
      if (!Array.isArray(spec.appConfigFields) || spec.appConfigFields.length === 0) {
        issues.push('credential.appConfigFields: expected the operator settings of the app');
      }
      if (typeof spec.installUrl !== 'function')
        issues.push('credential.installUrl: expected a function');
      if (typeof spec.installationIdParam !== 'string' || spec.installationIdParam.length === 0) {
        issues.push('credential.installationIdParam: expected a query parameter name');
      }
      if (spec.userVerification !== undefined) issues.push(...userVerificationIssues(spec));
      if (spec.manifestRegistration !== undefined) {
        issues.push(...manifestRegistrationIssues(spec, plugin));
      }
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

/** Upper bound of a declared page size. */
export const MAX_INSTALLATIONS_PER_PAGE = 1000;
const CLIENT_AUTH_METHODS: readonly string[] = ['client_secret_basic', 'client_secret_post'];

function userVerificationIssues(spec: AppInstallCredentialSpec): string[] {
  const at = 'credential.userVerification';
  const v: unknown = spec.userVerification;
  if (!isRecord(v)) return [`${at}: expected an object when present`];
  const issues: string[] = [];
  if (!isName(v.codeParam)) {
    issues.push(`${at}.codeParam: expected a query parameter name`);
  } else if (v.codeParam === spec.installationIdParam || v.codeParam === 'state') {
    issues.push(`${at}.codeParam: must differ from installationIdParam and from 'state'`);
  }
  for (const key of ['tokenUrl', 'installationsUrl'] as const) {
    if (!isHttpsUrl(v[key])) issues.push(`${at}.${key}: expected an https URL`);
  }
  if (typeof v.clientAuthMethod !== 'string' || !CLIENT_AUTH_METHODS.includes(v.clientAuthMethod)) {
    issues.push(`${at}.clientAuthMethod: expected ${CLIENT_AUTH_METHODS.join(' | ')}`);
  }
  if (!isName(v.installationIdField)) {
    issues.push(`${at}.installationIdField: expected a property name`);
  }
  if (v.installationsListField !== undefined && !isName(v.installationsListField)) {
    issues.push(`${at}.installationsListField: expected a property name when present`);
  }
  issues.push(...installationsHeaderIssues(v.installationsHeaders, at));
  issues.push(...paginationIssues(v.pagination, at));
  issues.push(...oauthClientFieldIssues(spec));
  return issues;
}

function installationsHeaderIssues(
  headers: unknown,
  at: string,
  field = 'installationsHeaders',
): string[] {
  if (headers === undefined) return [];
  if (!isRecord(headers)) return [`${at}.${field}: expected a record of header values`];
  const issues: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      issues.push(`${at}.${field}.${name}: expected a string`);
    }
    if (name.toLowerCase() === 'authorization') {
      issues.push(`${at}.${field}: the host sets Authorization itself`);
    }
  }
  return issues;
}

function paginationIssues(pagination: unknown, at: string): string[] {
  if (pagination === undefined) return [];
  if (!isRecord(pagination)) return [`${at}.pagination: expected an object when present`];
  const issues: string[] = [];
  const { pageParam, perPageParam, perPage } = pagination;
  if (!isName(pageParam) || !isName(perPageParam) || pageParam === perPageParam) {
    issues.push(`${at}.pagination: pageParam and perPageParam must be two parameter names`);
  }
  if (
    typeof perPage !== 'number' ||
    !Number.isInteger(perPage) ||
    perPage < 1 ||
    perPage > MAX_INSTALLATIONS_PER_PAGE
  ) {
    issues.push(
      `${at}.pagination.perPage: expected an integer from 1 to ${MAX_INSTALLATIONS_PER_PAGE}`,
    );
  }
  return issues;
}

const MANIFEST_FUNCTIONS = [
  'registrationUrl',
  'buildManifest',
  'conversionUrl',
  'registeredApp',
] as const;

function manifestRegistrationIssues(
  spec: AppInstallCredentialSpec,
  plugin: ProviderPlugin,
): string[] {
  const at = 'credential.manifestRegistration';
  const m: unknown = spec.manifestRegistration;
  if (!isRecord(m)) return [`${at}: expected an object when present`];
  const issues: string[] = [];
  for (const fn of MANIFEST_FUNCTIONS) {
    if (typeof m[fn] !== 'function') issues.push(`${at}.${fn}: expected a function`);
  }
  for (const key of ['manifestField', 'stateParam', 'codeParam'] as const) {
    if (!isName(m[key])) issues.push(`${at}.${key}: expected a parameter name`);
  }
  if (isName(m.stateParam) && m.stateParam === m.codeParam) {
    issues.push(`${at}: stateParam and codeParam must differ`);
  }
  if (typeof m.ownerLoginPattern !== 'string' || !isRegExpSource(m.ownerLoginPattern)) {
    issues.push(`${at}.ownerLoginPattern: expected a regular expression`);
  }
  const max = m.nameMaxLength;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
    issues.push(`${at}.nameMaxLength: expected a positive integer`);
  }
  issues.push(...installationsHeaderIssues(m.conversionHeaders, at, 'conversionHeaders'));
  issues.push(...appPermissionIssues(m.permissions, at, plugin));
  return issues;
}

function appPermissionIssues(permissions: unknown, at: string, plugin: ProviderPlugin): string[] {
  if (!isList(permissions) || permissions.length === 0) {
    return [`${at}.permissions: expected at least one permission`];
  }
  const tools = new Set(isList(plugin.tools) ? plugin.tools.map((t) => t.name) : []);
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of permissions.entries()) {
    const where = `${at}.permissions[${i}]`;
    if (!isRecord(raw) || !isName(raw.name) || !isName(raw.label) || !isName(raw.description)) {
      issues.push(`${where}: expected a name, a label and a description`);
      continue;
    }
    if (seen.has(raw.name)) issues.push(`${where}: '${raw.name}' is declared twice`);
    seen.add(raw.name);
    if (!isList(raw.levels) || raw.levels.length === 0) {
      issues.push(`${where}.levels: expected at least one level`);
      continue;
    }
    issues.push(...levelIssues(raw.levels, where, tools));
  }
  return issues;
}

function levelIssues(
  levels: readonly unknown[],
  where: string,
  tools: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const accesses = new Set<string>();
  for (const level of levels) {
    if (!isRecord(level) || !isName(level.access) || !isName(level.label) || !isList(level.tools)) {
      issues.push(`${where}.levels: each level needs an access, a label and a list of tools`);
      continue;
    }
    if (accesses.has(level.access)) issues.push(`${where}: level '${level.access}' twice`);
    accesses.add(level.access);
    for (const tool of level.tools) {
      if (typeof tool !== 'string' || !tools.has(tool)) {
        issues.push(`${where}.${level.access}: '${String(tool)}' is not a tool of the plugin`);
      }
    }
    const onlyWhen: unknown = level.onlyWhen;
    if (onlyWhen === undefined) continue;
    if (!isRecord(onlyWhen)) {
      issues.push(`${where}.${level.access}.onlyWhen: expected tool → condition`);
      continue;
    }
    for (const [tool, words] of Object.entries(onlyWhen)) {
      if (!level.tools.includes(tool) || !isName(words)) {
        issues.push(`${where}.${level.access}.onlyWhen: '${tool}' must be one of its tools`);
      }
    }
  }
  return issues;
}

function isRegExpSource(source: string): boolean {
  if (source.length === 0) return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** The host authenticates the app's OAuth client : the operator must be asked for it. */
function oauthClientFieldIssues(spec: AppInstallCredentialSpec): string[] {
  const issues: string[] = [];
  const fields = isList(spec.appConfigFields) ? spec.appConfigFields : [];
  const clientId = fields.find((f) => f.name === CLIENT_ID_FIELD);
  const clientSecret = fields.find((f) => f.name === CLIENT_SECRET_FIELD);
  if (!clientId || clientId.secret || clientId.required === false) {
    issues.push(
      `credential.appConfigFields: userVerification needs a required, non-secret '${CLIENT_ID_FIELD}' field`,
    );
  }
  if (!clientSecret || !clientSecret.secret || clientSecret.required === false) {
    issues.push(
      `credential.appConfigFields: userVerification needs a required, secret '${CLIENT_SECRET_FIELD}' field`,
    );
  }
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
