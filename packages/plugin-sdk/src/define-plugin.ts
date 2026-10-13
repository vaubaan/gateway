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

import { CREDENTIAL_KINDS, isProviderId, toolPrefixFor, validateDataModel } from '@vaubaan/shared';

import { semanticIssues } from './catalog-loader.ts';
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

  if (!isList(plugin.tools)) {
    issues.push('tools: expected a list of McpToolDeclaration');
  } else if (typeof plugin.id === 'string') {
    const prefix = toolPrefixFor(plugin.id);
    const seen = new Set<string>();
    plugin.tools.forEach((tool, i) => {
      if (!tool.name.startsWith(prefix) || tool.name.length === prefix.length) {
        issues.push(`tools[${i}].name '${tool.name}' must start with '${prefix}'`);
      }
      if (seen.has(tool.name)) issues.push(`tools[${i}].name '${tool.name}' is declared twice`);
      seen.add(tool.name);
      if (tool.inputSchema?.type !== 'object')
        issues.push(`tools[${i}].inputSchema.type must be 'object'`);
    });
  }

  if (!plugin.dataModel || typeof plugin.dataModel !== 'object') {
    issues.push('dataModel: missing');
  } else {
    if (plugin.dataModel.provider !== plugin.id) {
      issues.push(`dataModel.provider '${plugin.dataModel.provider}' must equal the plugin id`);
    }
    issues.push(...validateDataModel(plugin.dataModel).map((m) => `dataModel: ${m}`));
  }

  if (!plugin.catalog || typeof plugin.catalog !== 'object') {
    issues.push(
      'catalog: missing — load it with loadCatalogFile(catalogPathNextTo(import.meta.url))',
    );
  } else {
    if (plugin.catalog.provider !== plugin.id) {
      issues.push(`catalog.provider '${plugin.catalog.provider}' must equal the plugin id`);
    }
    issues.push(...semanticIssues(plugin.catalog).map((m) => `catalog: ${m}`));
  }

  issues.push(...credentialSpecIssues(plugin));

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
  if (!(CREDENTIAL_KINDS as readonly string[]).includes(spec.kind)) {
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
