/**
 * The plugin catalog of the site (website spec §2.3), built from the
 * repository at build time and nowhere else: a plugin is listed because its
 * folder exists under `plugins/`. Each plugin is loaded the way the gateway
 * loads it — its package's entry module, whose `definePlugin` validates the
 * declaration and whose catalog is read from `risk-catalog.yaml` by the
 * plugin SDK's loader — and reduced to plain data the pages can render.
 *
 * Nothing of the gateway is restated here: severity, tier, gates and budgets
 * come from `@vaubaan/policy-engine`, the client source from the plugin SDK,
 * the worked examples from the plugin's own `classify` (`plugin-examples.ts`).
 *
 * Folders whose name starts with `_` are kits, not plugins (`_template`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  isBrokeredSpec,
  type CredentialSpec,
  type GuideStep,
  type ProviderPlugin,
  type TokenExpiry,
  type TokenReach,
} from '@vaubaan/plugin-sdk';
import {
  budgetAtTrustLevel,
  isAcceptableInEnv,
  resolveVector,
  severityLevel,
  severityOf,
  tierOf,
  TRUST_LEVEL_GATES,
  TRUST_LEVELS,
  type SeverityLevel,
  type Tier,
  type TrustLevel,
} from '@vaubaan/policy-engine';
import type { Gate, MacroActionEntry, RiskEntry, RiskVector } from '@vaubaan/shared';

import {
  classifyExamples,
  workedMission,
  type ExampleInfo,
  type WorkedMission,
} from './plugin-examples';

/** The one severity word of a permission, the gateway interface's (style guide §2). */
export type Severity = SeverityLevel;

function severityWord(vector: RiskVector): Severity {
  return severityLevel(severityOf(vector));
}

export interface ToolInfo {
  readonly name: string;
  readonly title: string | null;
  readonly description: string;
}

export type RiskKind = 'read' | 'write' | 'destructive';

/**
 * The undo fact of a permission, in the gateway interface's word for its
 * `reversibility` (style guide §2, "the six risk axes are words"). Copied,
 * since the site may not import `apps/gateway`: `sources-agree.test.ts`
 * compares it with the gateway's vocabulary.
 */
export const UNDO_WORDS = {
  reversible: 'easy',
  costly: 'costly',
  irreversible: 'impossible',
} as const satisfies Record<RiskVector['reversibility'], string>;

export type UndoWord = (typeof UNDO_WORDS)[RiskVector['reversibility']];

/** A permission in one environment its catalog names (`acceptable_in_envs`, `vector_overrides`). */
export interface RiskEnvVariant {
  readonly env: string;
  readonly vector: RiskVector;
  readonly severity: Severity;
  readonly tier: Tier;
  readonly undo: UndoWord;
  /** False when `acceptable_in_envs` leaves this environment out: no mission holds it there. */
  readonly acceptable: boolean;
}

export interface RiskInfo {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
  readonly severity: Severity;
  /** The six facts, as the catalog declares them. */
  readonly vector: RiskVector;
  readonly undo: UndoWord;
  /** `tierOf` from the policy engine: what the trust levels read. A page never prints "tier". */
  readonly tier: Tier;
  /** The catalog's per-minute ceiling (`infra_limits.calls_per_minute_max`), when declared. */
  readonly rateCeilingPerMinute: number | null;
  /** The slice patterns the permission covers (`matches`). */
  readonly patterns: readonly string[];
  readonly replacedBy: string | null;
  /** One row per environment the catalog names for this permission. */
  readonly envVariants: readonly RiskEnvVariant[];
  readonly kind: RiskKind;
  /** Environment labels whose own vector gives another severity (`prod: high`). */
  readonly severityByEnv: readonly { readonly env: string; readonly severity: Severity }[];
  /** The only environment labels this permission may be accepted for, when the catalog restricts it. */
  readonly acceptableInEnvs: readonly string[] | null;
  readonly fallback: boolean;
  readonly deprecated: boolean;
}

/** The line a trust level writes: the gate (`null`: left out) and the budget, by the policy engine. */
export interface LevelBudget {
  readonly gate: Gate | null;
  readonly quota: number;
  readonly rateMax: number;
  readonly rateWindowSeconds: number;
}

export type LevelBudgets = Readonly<Record<TrustLevel, LevelBudget>>;

/** One risk of a macro-action with its base budget: no gate, the trust level decides it. */
export interface MacroActionEntryInfo {
  readonly riskId: string;
  readonly quota: number;
  readonly rateMax: number;
  readonly rateWindowSeconds: number;
  /** The line each trust level writes, for the catalog's vector. */
  readonly levels: LevelBudgets;
  /** The lines in each acceptable environment of the permission, whose vector may move the gate. */
  readonly envLevels: readonly { readonly env: string; readonly levels: LevelBudgets }[];
}

/** A macro-action of the catalog (ADR macro-actions-and-trust-levels-prefill-the-policy). */
export interface MacroActionInfo {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The catalog's prose of the macro-action (risk model §4.6), when it has one. */
  readonly narrative: string | null;
  readonly entries: readonly MacroActionEntryInfo[];
}

export interface CredentialFieldInfo {
  readonly label: string;
  readonly secret: boolean;
  readonly help: string | null;
}

/**
 * Where the credential comes from, one of the three ways of connecting
 * (website spec §2.3 item 7): a key the person creates at the service and
 * pastes (`api-key`, `ssh-key`), a client the gateway registers itself at the
 * service (`oauth2` with `clientRegistration`), or an OAuth broker's client
 * (`oauth2` with `broker`).
 */
export type ClientSource = 'pasted-key' | 'gateway-registered' | 'broker';

export interface CredentialInfo {
  readonly kind: CredentialSpec['kind'];
  readonly clientSource: ClientSource;
  /** The provider the broker runs the flow at (`google`), for a brokered way only. */
  readonly brokerProvider: string | null;
  /** What the person creates, in the provider's words, when the plugin says. */
  readonly label: string | null;
  readonly fields: readonly CredentialFieldInfo[];
  readonly createUrl: string | null;
  readonly steps: readonly GuideStep[];
  readonly reach: TokenReach | null;
  readonly permissions: readonly { readonly name: string; readonly access: string }[];
  readonly expiry: TokenExpiry | null;
  readonly docsUrl: string | null;
  /** The exact scopes an `oauth2` way asks for. */
  readonly scopes: readonly string[];
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
  readonly icon: string | null;
  readonly iconColor: string | null;
  readonly resourceNoun: { readonly one: string; readonly other: string } | null;
  /** Tools of the service the plugin deliberately leaves out, each with its reason. */
  readonly excludedTools: readonly { readonly name: string; readonly reason: string }[];
  readonly docsUrl: string | null;
  readonly manualRevocation: string | null;
  readonly catalogVersion: number | null;
  readonly catalogDate: string | null;
  readonly tools: readonly ToolInfo[];
  readonly risks: readonly RiskInfo[];
  readonly macroActions: readonly MacroActionInfo[];
  /** The declared examples, classified when the site is built (`plugin-examples.ts`). */
  readonly examples: readonly ExampleInfo[];
  /** The first two macro-actions at Careful, as the policy engine expands them. */
  readonly workedMission: WorkedMission;
  readonly credentials: readonly CredentialInfo[];
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

/** The environments a catalog entry names: its acceptable ones, then those it overrides. */
function envsNamedBy(entry: RiskEntry): string[] {
  return [
    ...new Set([...(entry.acceptable_in_envs ?? []), ...Object.keys(entry.vector_overrides ?? {})]),
  ];
}

function envVariant(entry: RiskEntry, env: string): RiskEnvVariant {
  const vector = resolveVector(entry, env);
  return {
    env,
    vector: { ...vector },
    severity: severityWord(vector),
    tier: tierOf(vector),
    undo: UNDO_WORDS[vector.reversibility],
    acceptable: isAcceptableInEnv(entry, env),
  };
}

function riskInfo(entry: RiskEntry): RiskInfo {
  const severity = severityWord(entry.vector);
  const severityByEnv = Object.entries(entry.vector_overrides ?? {})
    .map(([env, override]) => ({
      env,
      severity: severityWord({ ...entry.vector, ...override }),
    }))
    .filter((row) => row.severity !== severity);
  return {
    id: entry.id,
    label: entry.label,
    reason: entry.reason,
    severity,
    vector: { ...entry.vector },
    undo: UNDO_WORDS[entry.vector.reversibility],
    tier: tierOf(entry.vector),
    rateCeilingPerMinute: entry.infra_limits?.calls_per_minute_max ?? null,
    patterns: [...patternsOf(entry)],
    replacedBy: entry.replaced_by ?? null,
    envVariants: envsNamedBy(entry).map((env) => envVariant(entry, env)),
    kind: kindOf(entry),
    severityByEnv,
    acceptableInEnvs: entry.acceptable_in_envs ? [...entry.acceptable_in_envs] : null,
    fallback: entry.fallback === true,
    deprecated: entry.deprecated === true,
  };
}

/** The line each trust level writes for a risk of this vector and base budget. */
function levelBudgets(
  vector: RiskVector,
  entry: MacroActionEntry,
  ceiling: number | null,
): LevelBudgets {
  const tier = tierOf(vector);
  const base = { quota: entry.quota, rate_limit: entry.rate_limit };
  const line = (level: TrustLevel): LevelBudget => {
    const budget = budgetAtTrustLevel(base, level, ceiling);
    return {
      gate: TRUST_LEVEL_GATES[level][tier],
      quota: budget.quota,
      rateMax: budget.rate_limit.max,
      rateWindowSeconds: budget.rate_limit.window_seconds,
    };
  };
  const [careful, trusting, autonomous] = TRUST_LEVELS;
  return { careful: line(careful), trusting: line(trusting), autonomous: line(autonomous) };
}

function macroActionEntryInfo(
  entry: MacroActionEntry,
  risks: ReadonlyMap<string, RiskEntry>,
): MacroActionEntryInfo {
  const risk = risks.get(entry.risk_id);
  if (risk === undefined) throw new Error(`macro-action entry '${entry.risk_id}': no such risk`);
  const ceiling = risk.infra_limits?.calls_per_minute_max ?? null;
  return {
    riskId: entry.risk_id,
    quota: entry.quota,
    rateMax: entry.rate_limit.max,
    rateWindowSeconds: entry.rate_limit.window_seconds,
    levels: levelBudgets(risk.vector, entry, ceiling),
    envLevels: envsNamedBy(risk)
      .filter((env) => isAcceptableInEnv(risk, env))
      .map((env) => ({ env, levels: levelBudgets(resolveVector(risk, env), entry, ceiling) })),
  };
}

function clientSourceOf(spec: CredentialSpec): ClientSource {
  if (spec.kind !== 'oauth2') return 'pasted-key';
  return isBrokeredSpec(spec) ? 'broker' : 'gateway-registered';
}

function credentialInfo(spec: CredentialSpec): CredentialInfo {
  // An `oauth2` way asks for nothing: the gateway registers its own client at the service,
  // or signs in through the OAuth broker it is enrolled with (`broker`).
  const fields = spec.kind === 'api-key' || spec.kind === 'ssh-key' ? spec.fields : [];
  const guide = spec.kind === 'api-key' ? spec.guide : undefined;
  return {
    kind: spec.kind,
    clientSource: clientSourceOf(spec),
    brokerProvider: spec.kind === 'oauth2' && isBrokeredSpec(spec) ? spec.broker.provider : null,
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
  };
}

/**
 * The plain data the site shows of one plugin. Throws `ExampleError` when a
 * declared example does not classify onto the plugin's own catalog: the build
 * fails rather than publish a page showing what the gateway would not do.
 */
export function pluginInfo(plugin: ProviderPlugin, dir: string, packageName: string): PluginInfo {
  const catalog = plugin.catalog;
  const risksById = new Map(catalog.risks.map((r) => [r.id, r]));
  return {
    id: plugin.id,
    name: plugin.displayName,
    version: plugin.version,
    packageName,
    dir,
    description: plugin.description ?? '',
    summary: plugin.summary ?? null,
    icon: plugin.icon ?? null,
    iconColor: plugin.iconColor ?? null,
    resourceNoun: plugin.resourceNoun
      ? { one: plugin.resourceNoun.one, other: plugin.resourceNoun.other }
      : null,
    excludedTools: Object.entries(plugin.excludedTools ?? {}).map(([name, reason]) => ({
      name,
      reason,
    })),
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
      narrative: action.narrative ?? null,
      entries: action.entries.map((entry) => macroActionEntryInfo(entry, risksById)),
    })),
    examples: classifyExamples(plugin),
    workedMission: workedMission(plugin),
    credentials: [credentialInfo(plugin.credential)],
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
