/**
 * `definePlugin` — validate a plugin definition once, at module load.
 *
 * ADR : docs/decisions/plugin-contract-and-credential-spec.md.
 *
 * A plugin that passes `definePlugin` is well-formed by construction : id
 * grammar, semver, tool prefixes, catalog service, data-model integrity,
 * macro-actions, credential spec. The registry repeats nothing of this ; it only
 * checks what spans several plugins (unique ids, unique tool names).
 */

import { isServiceId, toolPrefixFor, validateDataModel } from '@vaubaan/shared';

import { semanticIssues } from './catalog-rules.ts';
import {
  CREDENTIAL_SENTENCE_MAX_LENGTH,
  credentialSpecIssues,
  isSentence,
} from './credential-issues.ts';
import { catalogPathIssues } from './data-model-paths.ts';
import { isList, isRecord } from './guards.ts';
import type { ServicePlugin } from './plugin.ts';

/** Semver 2.0, pre-release allowed, no build metadata. */
export const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Upper bound of `ServicePlugin.summary` : a paragraph, not a handbook. */
export const PLUGIN_SUMMARY_MAX_LENGTH = 600;

/**
 * `ServicePlugin.icon` : the `d` attribute of one SVG path — a drawing
 * command first, then commands, numbers and separators only. No markup, no
 * `url(…)`, nothing a page could not put inside `<path d="…">` as it is.
 */
export const SVG_PATH_DATA_PATTERN = /^[Mm][0-9A-Za-z.,\s+-]*$/;

/** `ServicePlugin.iconColor` : one sRGB colour as six hex digits, `#RRGGBB`, nothing a stylesheet could misread. */
export const HEX_COLOUR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** Upper bound of one `ServicePlugin.toolTitles` entry : a headline, not a description. */
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
export function pluginIssues(plugin: ServicePlugin): string[] {
  return [
    ...identityIssues(plugin),
    ...resourceNounIssues(plugin),
    ...toolIssues(plugin),
    ...toolTitleIssues(plugin),
    ...secretArgumentIssues(plugin),
    ...dataModelIssues(plugin),
    ...catalogIssues(plugin),
    ...credentialSpecIssues(plugin.credential, declaredToolNames(plugin)),
    ...hookIssues(plugin),
    ...retiredTokenHandoutIssues(plugin),
    ...resourceCreatingToolIssues(plugin),
    ...resourceRevealingToolIssues(plugin),
    ...gitRemoteIssues(plugin),
    ...toolReasonIssues(plugin.unboundTools, declaredToolNames(plugin), 'unboundTools'),
    ...excludedToolIssues(plugin),
    ...sampleIssues(plugin.examples, declaredToolNames(plugin)),
  ];
}

/** Every tool name a plugin answers for : its MCP tools and the two tools of its git remote. */
export function declaredToolNames(plugin: Pick<ServicePlugin, 'tools' | 'gitRemote'>): Set<string> {
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
function gitRemoteIssues(plugin: ServicePlugin): string[] {
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

/**
 * `tokenHandouts` is retired (owner decision of 2026-10-31, spec §2.4): no
 * tool hands the agent a service token. A plugin that still declares one is
 * refused, rather than loaded with a tool nothing gates any more.
 */
function retiredTokenHandoutIssues(plugin: ServicePlugin): string[] {
  return Object.hasOwn(plugin, 'tokenHandouts') ? [RETIRED_TOKEN_HANDOUTS_ISSUE] : [];
}

/** What a plugin that still declares `tokenHandouts` reads. */
export const RETIRED_TOKEN_HANDOUTS_ISSUE =
  'tokenHandouts: retired, no tool may hand the agent a service token (spec §2.4) ; remove the key and route the work through the gateway';

function identityIssues(plugin: ServicePlugin): string[] {
  const issues: string[] = [];
  if (typeof plugin.id !== 'string' || !isServiceId(plugin.id)) {
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

/** Upper bound of each form of `ServicePlugin.resourceNoun` : a word or two. */
export const RESOURCE_NOUN_MAX_LENGTH = 40;

/** A lowercase noun : starts and ends with a letter or digit, words joined by one space or a hyphen. */
const RESOURCE_NOUN_WORD = /^[a-z0-9]+$/;

/** Split on the separators first, so no pattern repeats a group (no backtracking). */
function isResourceNoun(word: string): boolean {
  return word.split(/[ -]/).every((part) => RESOURCE_NOUN_WORD.test(part));
}

/**
 * `resourceNoun` : two forms, each a lowercase noun on one line (letters,
 * digits, spaces, hyphens), without surrounding spaces — the interface puts it
 * after a count and capitalises it itself.
 */
function resourceNounIssues(plugin: ServicePlugin): string[] {
  const noun: unknown = plugin.resourceNoun;
  if (noun === undefined) return [];
  if (!isRecord(noun)) return ['resourceNoun: expected { one, other } when present'];
  const issues: string[] = [];
  for (const form of ['one', 'other'] as const) {
    const word = noun[form];
    if (typeof word !== 'string' || word.trim() === '') {
      issues.push(`resourceNoun.${form}: expected a non-empty string`);
    } else if (word.length > RESOURCE_NOUN_MAX_LENGTH) {
      issues.push(`resourceNoun.${form}: expected at most ${RESOURCE_NOUN_MAX_LENGTH} characters`);
    } else if (!isResourceNoun(word)) {
      issues.push(
        `resourceNoun.${form}: expected a lowercase noun (letters, digits, single spaces, hyphens), got '${word}'`,
      );
    }
  }
  return issues;
}

/** Upper bound of `ServicePlugin.manualRevocation` : a sentence or two. */
export const PLUGIN_MANUAL_REVOCATION_MAX_LENGTH = 400;

function toolIssues(plugin: ServicePlugin): string[] {
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
function resourceCreatingToolIssues(plugin: ServicePlugin): string[] {
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
 * `resourceRevealingTools` names MCP tools of the plugin, once each, none of
 * them a creating tool : a creating tool already triggers the discovery, and
 * its answer adds to the mission what a revealing tool's never does.
 */
function resourceRevealingToolIssues(plugin: ServicePlugin): string[] {
  const declared: unknown = plugin.resourceRevealingTools;
  if (declared === undefined) return [];
  if (!isList(declared) || declared.length === 0) {
    return ['resourceRevealingTools: expected a non-empty list of tool names when present'];
  }
  const mcp = new Set(isList(plugin.tools) ? plugin.tools.map((t) => t?.name) : []);
  const creating = new Set<unknown>(
    isList(plugin.resourceCreatingTools) ? plugin.resourceCreatingTools : [],
  );
  const issues: string[] = [];
  const seen = new Set<unknown>();
  for (const tool of declared) {
    if (typeof tool !== 'string' || !mcp.has(tool)) {
      issues.push(`resourceRevealingTools: '${String(tool)}' is not a tool of this plugin`);
    } else if (seen.has(tool)) {
      issues.push(`resourceRevealingTools: '${tool}' is listed twice`);
    } else if (creating.has(tool)) {
      issues.push(`resourceRevealingTools: '${tool}' is a creating tool already`);
    }
    seen.add(tool);
  }
  return issues;
}

/**
 * `secretArguments` names declared tools and, for each, arguments its input
 * schema declares : a masked name that is not an argument would mask nothing.
 */
function secretArgumentIssues(plugin: ServicePlugin): string[] {
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
function toolTitleIssues(plugin: ServicePlugin): string[] {
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

function dataModelIssues(plugin: ServicePlugin): string[] {
  if (!plugin.dataModel || typeof plugin.dataModel !== 'object') return ['dataModel: missing'];
  const issues: string[] = [];
  if (plugin.dataModel.service !== plugin.id) {
    issues.push(`dataModel.service '${plugin.dataModel.service}' must equal the plugin id`);
  }
  issues.push(...validateDataModel(plugin.dataModel).map((m) => `dataModel: ${m}`));
  return issues;
}

/**
 * The catalog rules of `semanticIssues` — fallback, wildcards, macro-actions
 * and their base budgets. This is the only validation a catalog written in
 * TypeScript goes through, so everything that must hold for every catalog
 * lives there, not in the YAML parser. Then every live pattern walked on the
 * plugin's data model (`catalogPathIssues`) : a pattern off the model
 * matches nothing, silently. Walked only on a model that is itself sound,
 * whose own issues `dataModelIssues` reports.
 */
function catalogIssues(plugin: ServicePlugin): string[] {
  if (!plugin.catalog || typeof plugin.catalog !== 'object') {
    return ['catalog: missing — load it with loadCatalogFile(catalogPathNextTo(import.meta.url))'];
  }
  const issues: string[] = [];
  if (plugin.catalog.service !== plugin.id) {
    issues.push(`catalog.service '${plugin.catalog.service}' must equal the plugin id`);
  }
  issues.push(...semanticIssues(plugin.catalog).map((m) => `catalog: ${m}`));
  if (isList(plugin.catalog.risks) && dataModelIssues(plugin).length === 0) {
    issues.push(...catalogPathIssues(plugin).map((m) => `catalog: ${m}`));
  }
  return issues;
}

function hookIssues(plugin: ServicePlugin): string[] {
  const issues: string[] = [];
  for (const fn of ['classify', 'execute', 'discoverResources'] as const) {
    if (typeof plugin[fn] !== 'function') issues.push(`${fn}: expected a function`);
  }
  for (const fn of ['envOf', 'refresh'] as const) {
    if (plugin[fn] !== undefined && typeof plugin[fn] !== 'function')
      issues.push(`${fn}: expected a function when present`);
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
 * `excludedTools` names tools of the service the plugin deliberately does not
 * expose, one sentence each : a name the plugin also declares would be exposed
 * and excluded at once.
 */
function excludedToolIssues(plugin: ServicePlugin): string[] {
  const excluded: unknown = plugin.excludedTools;
  if (excluded === undefined) return [];
  if (!isRecord(excluded)) return ['excludedTools: expected a record tool → reason'];
  const declared = declaredToolNames(plugin);
  const issues: string[] = [];
  for (const [tool, reason] of Object.entries(excluded)) {
    if (declared.has(tool)) {
      issues.push(
        `excludedTools: '${tool}' is a declared tool of this plugin, it cannot be excluded`,
      );
    }
    if (!isSentence(reason, CREDENTIAL_SENTENCE_MAX_LENGTH)) {
      issues.push(`excludedTools.${tool}: expected one sentence saying why`);
    }
  }
  return issues;
}

/**
 * The shape of a sample set : a record tool → non-empty list of samples, each
 * with an `args` object, `resources` a list and `expectDenied` a boolean when
 * present, and every key a tool of the plugin. Whether a sample classifies
 * into covered slices is the test kit's (`assertCatalogCoverage`), not a
 * load-time check.
 */
function sampleIssues(samples: unknown, tools: ReadonlySet<unknown>): string[] {
  const label = 'examples';
  if (samples === undefined) return [];
  if (!isRecord(samples)) return [`${label}: expected a record tool → sample calls`];
  const issues: string[] = [];
  for (const [tool, calls] of Object.entries(samples)) {
    if (!tools.has(tool)) issues.push(`${label}: '${tool}' is not a tool of this plugin`);
    if (!isList(calls) || calls.length === 0) {
      issues.push(`${label}.${tool}: expected a non-empty list of sample calls`);
      continue;
    }
    calls.forEach((call: unknown, i) => {
      const at = `${label}.${tool}[${i}]`;
      if (!isRecord(call) || !isRecord(call.args)) {
        issues.push(`${at}.args: expected an object`);
        return;
      }
      if (call.resources !== undefined && !isList(call.resources)) {
        issues.push(`${at}.resources: expected a list when present`);
      }
      if (call.expectDenied !== undefined && typeof call.expectDenied !== 'boolean') {
        issues.push(`${at}.expectDenied: expected a boolean when present`);
      }
    });
  }
  return issues;
}

/**
 * Validate and freeze a plugin definition. Throws `PluginDefinitionError`
 * with every issue, so a broken plugin fails at import time, not at the
 * first call.
 */
export function definePlugin<P extends ServicePlugin>(definition: P): P {
  const issues = pluginIssues(definition);
  if (issues.length > 0) throw new PluginDefinitionError(String(definition.id), issues);
  return Object.freeze(definition);
}
