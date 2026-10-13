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

import { semanticIssues } from './catalog-loader.ts';
import {
  CLIENT_ID_FIELD,
  CLIENT_SECRET_FIELD,
  type AppInstallCredentialSpec,
} from './credential.ts';
import type { ProviderPlugin } from './plugin.ts';

/** Semver 2.0, pre-release allowed, no build metadata. */
export const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

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
    ...dataModelIssues(plugin),
    ...catalogIssues(plugin),
    ...credentialSpecIssues(plugin),
    ...hookIssues(plugin),
  ];
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

function credentialSpecIssues(plugin: ProviderPlugin): string[] {
  const spec = plugin.credential;
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
      // `refreshable: true` needs no `refresh()` : the host performs the
      // standard refresh_token grant from the spec (ADR plugin-contract D2 as
      // amended by P1.2-align) ; `refresh` is an override for non-standard flows.
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

function installationsHeaderIssues(headers: unknown, at: string): string[] {
  if (headers === undefined) return [];
  if (!isRecord(headers)) return [`${at}.installationsHeaders: expected a record of header values`];
  const issues: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      issues.push(`${at}.installationsHeaders.${name}: expected a string`);
    }
    if (name.toLowerCase() === 'authorization') {
      issues.push(`${at}.installationsHeaders: the host sets Authorization itself`);
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
