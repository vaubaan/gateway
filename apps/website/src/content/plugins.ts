/**
 * The plugin catalog of the site (website spec §2.3), built from the
 * repository at build time and nowhere else: a plugin is listed because its
 * folder exists under `plugins/`. Each plugin is loaded the way the gateway
 * loads it — its package's entry module, whose `definePlugin` validates the
 * declaration and whose catalog is read from `risk-catalog.yaml` by the
 * plugin SDK's loader — and reduced to plain data the pages can render.
 *
 * Folders whose name starts with `_` are kits, not plugins (`_template`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  CredentialSpec,
  GuideStep,
  ProviderPlugin,
  TokenExpiry,
  TokenReach,
} from '@vaubaan/plugin-sdk';
import type { RiskEntry } from '@vaubaan/shared';

import { severityOf, type Severity } from './severity';

export interface ToolInfo {
  readonly name: string;
  readonly title: string | null;
  readonly description: string;
}

export type RiskKind = 'read' | 'write' | 'destructive';

export interface RiskInfo {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
  readonly severity: Severity;
  readonly kind: RiskKind;
  /** Environment labels whose own vector gives another severity (`prod: high`). */
  readonly severityByEnv: readonly { readonly env: string; readonly severity: Severity }[];
  /** The only environment labels this permission may be accepted for, when the catalog restricts it. */
  readonly acceptableInEnvs: readonly string[] | null;
  readonly fallback: boolean;
  readonly deprecated: boolean;
}

/** One risk of a macro-action with its base budget: no gate, the trust level decides it. */
export interface MacroActionEntryInfo {
  readonly riskId: string;
  readonly quota: number;
  readonly rateMax: number;
  readonly rateWindowSeconds: number;
}

/** A macro-action of the catalog (ADR macro-actions-and-trust-levels-prefill-the-policy). */
export interface MacroActionInfo {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly entries: readonly MacroActionEntryInfo[];
}

export interface CredentialFieldInfo {
  readonly label: string;
  readonly secret: boolean;
  readonly help: string | null;
}

export interface CredentialInfo {
  readonly kind: CredentialSpec['kind'];
  /** What the person creates, in the provider's words, when the plugin says. */
  readonly label: string | null;
  readonly fields: readonly CredentialFieldInfo[];
  readonly createUrl: string | null;
  readonly steps: readonly GuideStep[];
  readonly reach: TokenReach | null;
  readonly permissions: readonly { readonly name: string; readonly access: string }[];
  readonly expiry: TokenExpiry | null;
  readonly docsUrl: string | null;
  readonly scopes: readonly string[];
  /** `oauth2` whose client the gateway registers itself: nobody declares anything. */
  readonly registersItself: boolean;
}

export interface PluginInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly packageName: string;
  /** The plugin's folder, from the repository root (`plugins/github`). */
  readonly dir: string;
  readonly description: string;
  readonly summary: string | null;
  readonly docsUrl: string | null;
  readonly manualRevocation: string | null;
  readonly catalogVersion: number | null;
  readonly catalogDate: string | null;
  readonly tools: readonly ToolInfo[];
  readonly risks: readonly RiskInfo[];
  readonly macroActions: readonly MacroActionInfo[];
  readonly credentials: readonly CredentialInfo[];
  /** Tools that hand the agent a short-lived provider token, each a permission of its own. */
  readonly tokenHandouts: readonly { readonly tool: string; readonly riskIds: readonly string[] }[];
  readonly gitRemote: boolean;
}

/** `plugins/<name>` folders that hold a plugin: a `package.json`, a name not starting with `_`. */
export function discoverPluginDirs(repoRoot: string): string[] {
  const base = join(repoRoot, 'plugins');
  return readdirSync(base)
    .filter((name) => !name.startsWith('_') && !name.startsWith('.'))
    .filter((name) => statSync(join(base, name)).isDirectory())
    .filter((name) => existsSync(join(base, name, 'package.json')))
    .sort()
    .map((name) => `plugins/${name}`);
}

interface PackageJson {
  readonly name?: unknown;
  readonly exports?: unknown;
}

function entryModuleOf(pkg: PackageJson, dir: string): string {
  const exports = pkg.exports;
  const entry =
    typeof exports === 'string'
      ? exports
      : typeof exports === 'object' && exports !== null
        ? (exports as Record<string, unknown>)['.']
        : undefined;
  if (typeof entry !== 'string') throw new Error(`${dir}/package.json: no "exports" entry`);
  return entry;
}

function isPlugin(value: unknown): value is ProviderPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ProviderPlugin>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.version === 'string' &&
    Array.isArray(candidate.tools) &&
    typeof candidate.catalog === 'object'
  );
}

/** Imports the plugin of a folder through its package entry and returns its declaration. */
export async function importPlugin(repoRoot: string, dir: string): Promise<ProviderPlugin> {
  const pkgPath = join(repoRoot, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
  const entry = entryModuleOf(pkg, dir);
  const mod = (await import(pathToFileURL(join(repoRoot, dir, entry)).href)) as {
    default?: unknown;
  };
  if (!isPlugin(mod.default)) throw new Error(`${dir}: the entry module exports no plugin`);
  return mod.default;
}

function patternsOf(entry: Pick<RiskEntry, 'matches'>): readonly string[] {
  return typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
}

function kindOf(entry: RiskEntry): RiskKind {
  if (patternsOf(entry).every((pattern) => pattern.endsWith('.R'))) return 'read';
  return entry.vector.reversibility === 'irreversible' ? 'destructive' : 'write';
}

function riskInfo(entry: RiskEntry): RiskInfo {
  const severity = severityOf(entry.vector);
  const severityByEnv = Object.entries(entry.vector_overrides ?? {})
    .map(([env, override]) => ({
      env,
      severity: severityOf({ ...entry.vector, ...override }),
    }))
    .filter((row) => row.severity !== severity);
  return {
    id: entry.id,
    label: entry.label,
    reason: entry.reason,
    severity,
    kind: kindOf(entry),
    severityByEnv,
    acceptableInEnvs: entry.acceptable_in_envs ? [...entry.acceptable_in_envs] : null,
    fallback: entry.fallback === true,
    deprecated: entry.deprecated === true,
  };
}

function credentialInfo(spec: CredentialSpec): CredentialInfo {
  // An `oauth2` way asks for nothing: the gateway registers its own client at the service.
  const fields = spec.kind === 'api-key' || spec.kind === 'ssh-key' ? spec.fields : [];
  const guide = spec.kind === 'api-key' ? spec.guide : undefined;
  return {
    kind: spec.kind,
    label: spec.kind === 'api-key' ? (spec.label ?? null) : null,
    fields: fields.map((field) => ({
      label: field.label,
      secret: field.secret,
      help: field.help ?? null,
    })),
    createUrl: spec.kind === 'api-key' ? (spec.createUrl ?? null) : null,
    steps: guide ? [...guide.steps] : [],
    reach: guide?.reach ?? null,
    permissions: guide ? guide.permissions.map((p) => ({ name: p.name, access: p.access })) : [],
    expiry: guide?.expiry ?? null,
    docsUrl: guide?.docsUrl ?? null,
    scopes: spec.kind === 'oauth2' ? [...spec.scopes] : [],
    registersItself: spec.kind === 'oauth2',
  };
}

/** The plain data the site shows of one plugin. */
export function pluginInfo(plugin: ProviderPlugin, dir: string, packageName: string): PluginInfo {
  const catalog = plugin.catalog;
  return {
    id: plugin.id,
    name: plugin.displayName,
    version: plugin.version,
    packageName,
    dir,
    description: plugin.description ?? '',
    summary: plugin.summary ?? null,
    docsUrl: plugin.docsUrl ?? null,
    manualRevocation: plugin.manualRevocation ?? null,
    catalogVersion: catalog.catalog_version ?? null,
    catalogDate: catalog.catalog_date ?? null,
    tools: plugin.tools.map((tool) => ({
      name: tool.name,
      title: plugin.toolTitles?.[tool.name] ?? null,
      description: tool.description,
    })),
    risks: catalog.risks.map(riskInfo),
    macroActions: (catalog.macro_actions ?? []).map((action) => ({
      id: action.id,
      label: action.label,
      description: action.description,
      entries: action.entries.map((entry) => ({
        riskId: entry.risk_id,
        quota: entry.quota,
        rateMax: entry.rate_limit.max,
        rateWindowSeconds: entry.rate_limit.window_seconds,
      })),
    })),
    credentials: [credentialInfo(plugin.credential)],
    tokenHandouts: (plugin.tokenHandouts ?? []).map((handout) => ({
      tool: handout.tool,
      riskIds: [...handout.riskIds],
    })),
    gitRemote: plugin.gitRemote !== undefined,
  };
}

/** Every plugin of the repository, sorted by id. */
export async function loadPlugins(repoRoot: string): Promise<PluginInfo[]> {
  const plugins: PluginInfo[] = [];
  for (const dir of discoverPluginDirs(repoRoot)) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    const plugin = await importPlugin(repoRoot, dir);
    plugins.push(pluginInfo(plugin, dir, typeof pkg.name === 'string' ? pkg.name : dir));
  }
  return plugins.sort((a, b) => a.id.localeCompare(b.id));
}
