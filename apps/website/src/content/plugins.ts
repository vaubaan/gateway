/**
 * The plugin catalog of the site (website spec §2.3), built from the
 * repository at build time and nowhere else: a plugin is listed because its
 * folder exists under `plugins/`. Each plugin is loaded the way the gateway
 * loads it — its package's entry module, whose `definePlugin` validates the
 * declaration and whose catalog is read from `risk-catalog.yaml` by the
 * plugin SDK's loader — and reduced to plain data the pages can render.
 *
 * Nothing of the gateway is restated here: the row and its reason, gates,
 * budgets, "Anything else" and every word a person reads of the risk model
 * (the four rows, the reasons, the five facts and their values, the gate words) come from `@vaubaan/policy-engine`,
 * the client source from the plugin SDK, the worked examples from the
 * plugin's own `classify` (`plugin-examples.ts`). Each shape below is plain,
 * serialisable data: `plugins.json` writes it out as it is.
 *
 * Folders whose name starts with `_` are kits, not plugins (`_template`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  GUIDE_SCREENSHOT_DIR,
  isBrokeredSpec,
  screenshotAttribution,
  screenshotLicenceWords,
  screenshotSourceHost,
  type CredentialSpec,
  type GuideStep,
  type ProviderPlugin,
  type Screenshot,
  type ScreenshotLicence,
  type TokenExpiry,
  type TokenReach,
} from '@vaubaan/plugin-sdk';
import {
  ANYTHING_ELSE_MACRO_ACTION,
  budgetAtTrustLevel,
  gateWordOf,
  isAcceptableInEnv,
  macroActionsOf,
  parseSlice,
  REASON_AXIS,
  reasonOf,
  resolveVector,
  rowOf,
  TRUST_LEVEL_GATES,
  TRUST_LEVELS,
  WHY_LABELS,
  WHY_ORDER,
  WHY_VALUES,
  whyValue,
  type GateWord,
  type Reason,
  type Row,
  type TrustLevel,
  type WhyAxis,
} from '@vaubaan/policy-engine';
import type {
  DataModel,
  DataModelCardinality,
  Gate,
  MacroAction,
  MacroActionEntry,
  RiskEntry,
  RiskId,
  RiskVector,
} from '@vaubaan/shared';

import {
  classifyExamples,
  workedMission,
  type ExampleInfo,
  type WorkedMission,
} from './plugin-examples';

export type { Reason, Row } from '@vaubaan/policy-engine';

/** The undo fact in words (`WHY_VALUES.reversibility`): `easy`, `costly`, `impossible`. */
export type UndoWord = (typeof WHY_VALUES.reversibility)[RiskVector['reversibility']];

export interface ToolInfo {
  readonly name: string;
  readonly title: string | null;
  readonly description: string;
  /** What it usually touches: the permissions its classified examples touch, catalog order. */
  readonly touches: readonly RiskId[];
}

export type RiskKind = 'read' | 'write' | 'destructive';

/**
 * One of the five facts of a permission, in the gateway interface's words
 * (style guide §2): `WHY_LABELS`, `WHY_VALUES`.
 */
export interface FactInfo {
  readonly axis: WhyAxis;
  /** "Undo", "Blast radius"… */
  readonly label: string;
  /** The catalog's value (`irreversible`). */
  readonly value: string;
  /** The value in words (`impossible`). */
  readonly word: string;
  /** True when this fact gave the row its reason, so moved the gate (`reasonOf`): the page tints it. */
  readonly movesGate: boolean;
}

/** The five facts of a vector, in the order the gateway draws them (`WHY_ORDER`). */
export function factsOf(vector: RiskVector): FactInfo[] {
  const reason = reasonOf(vector);
  const moving = reason === null ? null : REASON_AXIS[reason];
  return WHY_ORDER.map((axis) => ({
    axis,
    label: WHY_LABELS[axis],
    value: vector[axis],
    word: whyValue(axis, vector[axis]),
    movesGate: axis === moving,
  }));
}

function undoWordOf(vector: RiskVector): UndoWord {
  return WHY_VALUES.reversibility[vector.reversibility];
}

/** A permission in one environment its catalog names (`acceptable_in_envs`, `vector_overrides`). */
export interface RiskEnvVariant {
  readonly env: string;
  readonly vector: RiskVector;
  readonly facts: readonly FactInfo[];
  /** `rowOf` in this environment: what the trust levels read. */
  readonly row: Row;
  /** `reasonOf` in this environment; `null` in row 1. */
  readonly rowReason: Reason | null;
  readonly undo: UndoWord;
  /** False when `acceptable_in_envs` leaves this environment out: no mission holds it there. */
  readonly acceptable: boolean;
}

export interface RiskInfo {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
  /** The five facts, as the catalog declares them. */
  readonly vector: RiskVector;
  /** The same five facts in the gateway's words, the one that moved the gate marked. */
  readonly facts: readonly FactInfo[];
  readonly undo: UndoWord;
  /** `rowOf` from the policy engine: the row it is printed with, what the trust levels read. */
  readonly row: Row;
  /** `reasonOf`: the branch of the tree that decided the row; `null` in row 1. */
  readonly rowReason: Reason | null;
  /** The catalog's per-minute ceiling (`infra_limits.calls_per_minute_max`), when declared. */
  readonly rateCeilingPerMinute: number | null;
  /** The slice patterns the permission covers (`matches`). */
  readonly patterns: readonly string[];
  readonly replacedBy: string | null;
  /** One row per environment the catalog names for this permission. */
  readonly envVariants: readonly RiskEnvVariant[];
  readonly kind: RiskKind;
  /** Environment labels whose own vector gives another row (`prod: 3`). */
  readonly rowByEnv: readonly { readonly env: string; readonly row: Row }[];
  /** The only environment labels this permission may be accepted for, when the catalog restricts it. */
  readonly acceptableInEnvs: readonly string[] | null;
  readonly fallback: boolean;
  readonly deprecated: boolean;
}

/**
 * The line a trust level writes: the gate (`null`: left out) and the budget,
 * by the policy engine. `quota` is calls per period, the period of a mission
 * being a day unless its creator picks another: the page writes it per day.
 */
export interface LevelBudget {
  readonly gate: Gate | null;
  /** The word class the gateway draws for the gate (`gateWordOf`; `off` when left out). */
  readonly gateWord: GateWord;
  readonly quota: number;
  readonly rateMax: number;
  readonly rateWindowSeconds: number;
}

export type LevelBudgets = Readonly<Record<TrustLevel, LevelBudget>>;

/** One risk of a macro-action with its base budget: no gate, the trust level decides it. */
export interface MacroActionEntryInfo {
  readonly riskId: RiskId;
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
  /** Its risks, in the order of the catalog's `risks` (the map's order), retired ones left out. */
  readonly entries: readonly MacroActionEntryInfo[];
}

/** A tool of the service the plugin deliberately leaves out (`excludedTools`). */
export interface ExcludedToolInfo {
  readonly name: string;
  readonly reason: string;
}

/** What the opening of a page counts; the gateways running it come from the collector. */
export interface PluginCounts {
  /** Permissions a mission can hold: neither the fallback nor retired ones. */
  readonly permissions: number;
  /** The catalog's own macro-actions ("Anything else" not counted). */
  readonly macroActions: number;
  readonly tools: number;
  readonly excludedTools: number;
  readonly examples: number;
}

export interface CredentialFieldInfo {
  readonly label: string;
  readonly secret: boolean;
  readonly help: string | null;
}

/**
 * Where the credential comes from, one of the three ways of connecting
 * (website spec §2.3 item 9): a key the person creates at the service and
 * pastes (`api-key`, `ssh-key`), a client the gateway registers itself at the
 * service (`oauth2` with `clientRegistration`), or an OAuth broker's client
 * (`oauth2` with `broker`).
 */
export type ClientSource = 'pasted-key' | 'gateway-registered' | 'broker';

/**
 * A screenshot of the connect guide as the site shows it: copied at build beside the
 * page (`src`), its provenance line derived by the SDK (`screenshotAttribution`).
 */
export interface ConnectFigureInfo {
  /** The file name in the plugin's `docs/connect/`. */
  readonly file: string;
  /** Where the page loads it: `/plugins/<id>/connect/<file>`. */
  readonly src: string;
  readonly alt: string;
  readonly attribution: string;
  /** The documentation it comes from (`docs.github.com`), `null` for one of ours. */
  readonly sourceHost: string | null;
  readonly licence: ScreenshotLicence;
  /** The licence as people read it: "CC BY 4.0". */
  readonly licenceWords: string;
}

/** One step of the guide: the sentence, the menus to follow, its page, command and figure. */
export interface ConnectStepInfo {
  readonly do: string;
  /** The provider's menu labels, in order; empty when the step has none. */
  readonly path: readonly string[];
  readonly url: string | null;
  readonly code: string | null;
  readonly figure: ConnectFigureInfo | null;
}

/** Where the site serves a screenshot of a plugin's connect guide. */
export function connectFigureSrc(pluginId: string, file: string): string {
  return `/plugins/${pluginId}/connect/${file}`;
}

/** The figures of a plugin, as `[public path, source file]` for the build to copy. */
export function connectFigureFiles(
  plugin: Pick<PluginInfo, 'dir' | 'credentials'>,
): [string, string][] {
  return plugin.credentials.flatMap((c) =>
    allSteps(c).flatMap((step) =>
      step.figure
        ? [
            [
              step.figure.src.replace(/^\//, ''),
              `${plugin.dir}/${GUIDE_SCREENSHOT_DIR}/${step.figure.file}`,
            ] as [string, string],
          ]
        : [],
    ),
  );
}

/**
 * One shape of the key (`alternatives` of an `api-key` spec, Vercel: a team or one
 * project): what the toggle of the connect guide says, and the steps of that shape,
 * which come before the guide's shared steps.
 */
export interface ConnectAlternativeInfo {
  readonly id: string;
  readonly label: string;
  readonly help: string | null;
  readonly steps: readonly ConnectStepInfo[];
}

export interface CredentialInfo {
  readonly kind: CredentialSpec['kind'];
  readonly clientSource: ClientSource;
  /** The provider the broker runs the flow at (`google`), for a brokered way only. */
  readonly brokerProvider: string | null;
  /** What the person creates, in the provider's words, when the plugin says. */
  readonly label: string | null;
  readonly fields: readonly CredentialFieldInfo[];
  readonly createUrl: string | null;
  /** The guide's own steps, shared by every alternative (they follow an alternative's steps). */
  readonly steps: readonly ConnectStepInfo[];
  /** The shapes of the key, two to four when declared, each with its own steps; empty otherwise. */
  readonly alternatives: readonly ConnectAlternativeInfo[];
  readonly reach: TokenReach | null;
  /** What to grant at the provider, each with the tools of the plugin that need it. */
  readonly permissions: readonly {
    readonly name: string;
    readonly access: string;
    readonly tools: readonly string[];
  }[];
  readonly expiry: TokenExpiry | null;
  readonly docsUrl: string | null;
  /** The exact scopes an `oauth2` way asks for (the broker's, for a brokered way). */
  readonly scopes: readonly string[];
  /** How the person removes the grant by hand at the provider, when the gateway cannot. */
  readonly manualRevocation: string | null;
}

/** Every step of a way of connecting: each alternative's, then the shared ones. */
export function allSteps(c: Pick<CredentialInfo, 'steps' | 'alternatives'>): ConnectStepInfo[] {
  return [...c.alternatives.flatMap((alt) => alt.steps), ...c.steps];
}

/** An entity of the plugin's data model (`dataModel`), as the model section draws it. */
export interface ModelEntityInfo {
  readonly name: string;
  /** The entity it nests in; `null` at the root of its plane. */
  readonly parent: string | null;
  readonly cardinalities: readonly DataModelCardinality[];
  readonly description: string;
  /** `envScopable`: this entity carries the service's environment. */
  readonly carriesEnv: boolean;
  /** True when a slice of a classified example names it: some tool touches it. */
  readonly touched: boolean;
}

export interface ModelPlaneInfo {
  readonly slug: string;
  readonly description: string | null;
  readonly entities: readonly ModelEntityInfo[];
}

/**
 * Where the environment of a call comes from (risk model §6), as the gateway's
 * provider reference says it: the call itself (the plugin declares `envOf`), the
 * label the owner puts on the resource, or nowhere (no catalog entry names one).
 */
export type EnvironmentSource = 'call' | 'resource-label' | 'none';

export interface EnvironmentInfo {
  readonly source: EnvironmentSource;
  /** Every environment an entry of the catalog can be accepted in, in the order the catalog first names them. */
  readonly envs: readonly string[];
  /** `plane.entity` of each entity the data model marks as the carrier. */
  readonly carriers: readonly string[];
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
  readonly excludedTools: readonly ExcludedToolInfo[];
  readonly docsUrl: string | null;
  readonly manualRevocation: string | null;
  readonly catalogVersion: number | null;
  readonly catalogDate: string | null;
  readonly tools: readonly ToolInfo[];
  readonly risks: readonly RiskInfo[];
  /** The fallback ("Anything else"): the fallback permissions at the gateway's base budget. */
  readonly anythingElse: MacroActionInfo | null;
  /** The ids of the retired permissions (`deprecated`), catalog order; each says its `replacedBy`. */
  readonly retired: readonly RiskId[];
  /** The catalog's own macro-actions, in catalog order. */
  readonly macroActions: readonly MacroActionInfo[];
  readonly counts: PluginCounts;
  /** The declared examples, classified when the site is built (`plugin-examples.ts`). */
  readonly examples: readonly ExampleInfo[];
  /** The first two macro-actions at Careful, as the policy engine expands them. */
  readonly workedMission: WorkedMission;
  readonly credentials: readonly CredentialInfo[];
  readonly gitRemote: boolean;
  /** The plugin's data model: its planes and their entities, declaration order. */
  readonly dataModel: { readonly planes: readonly ModelPlaneInfo[] };
  readonly environment: EnvironmentInfo;
  /** The file declaring the examples, from the repository root, when the plugin has one. */
  readonly examplesSource: string | null;
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
    facts: factsOf(vector),
    row: rowOf(vector),
    rowReason: reasonOf(vector),
    undo: undoWordOf(vector),
    acceptable: isAcceptableInEnv(entry, env),
  };
}

function riskInfo(entry: RiskEntry): RiskInfo {
  const row = rowOf(entry.vector);
  const rowByEnv = Object.entries(entry.vector_overrides ?? {})
    .map(([env, override]) => ({ env, row: rowOf({ ...entry.vector, ...override }) }))
    .filter((variant) => variant.row !== row);
  return {
    id: entry.id,
    label: entry.label,
    reason: entry.reason,
    vector: { ...entry.vector },
    facts: factsOf(entry.vector),
    undo: undoWordOf(entry.vector),
    row,
    rowReason: reasonOf(entry.vector),
    rateCeilingPerMinute: entry.infra_limits?.calls_per_minute_max ?? null,
    patterns: [...patternsOf(entry)],
    replacedBy: entry.replaced_by ?? null,
    envVariants: envsNamedBy(entry).map((env) => envVariant(entry, env)),
    kind: kindOf(entry),
    rowByEnv,
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
  const row = rowOf(vector);
  const base = { quota: entry.quota, rate_limit: entry.rate_limit };
  const line = (level: TrustLevel): LevelBudget => {
    const budget = budgetAtTrustLevel(base, level, ceiling);
    const gate = TRUST_LEVEL_GATES[level][row];
    return {
      gate,
      gateWord: gate === null ? 'off' : gateWordOf(gate),
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

/**
 * A macro-action as the page shows it: its entries in catalog order (the
 * map's), retired permissions left out as the gateway's form leaves them out.
 */
function macroActionInfo(
  action: MacroAction,
  risks: ReadonlyMap<string, RiskEntry>,
  order: ReadonlyMap<string, number>,
): MacroActionInfo {
  const rank = (id: string): number => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  return {
    id: action.id,
    label: action.label,
    description: action.description,
    narrative: action.narrative ?? null,
    entries: action.entries
      .filter((entry) => risks.get(entry.risk_id)?.deprecated !== true)
      .sort((a, b) => rank(a.risk_id) - rank(b.risk_id))
      .map((entry) => macroActionEntryInfo(entry, risks)),
  };
}

/** The permissions each tool's classified examples touch, catalog order. */
function touchesByTool(
  examples: readonly ExampleInfo[],
  order: ReadonlyMap<string, number>,
): Map<string, RiskId[]> {
  const byTool = new Map<string, Set<RiskId>>();
  for (const example of examples) {
    const set = byTool.get(example.tool) ?? new Set<RiskId>();
    for (const id of example.permissions) set.add(id);
    byTool.set(example.tool, set);
  }
  const rank = (id: string): number => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  return new Map(
    [...byTool].map(([tool, ids]) => [tool, [...ids].sort((a, b) => rank(a) - rank(b))]),
  );
}

function clientSourceOf(spec: CredentialSpec): ClientSource {
  if (spec.kind !== 'oauth2') return 'pasted-key';
  return isBrokeredSpec(spec) ? 'broker' : 'gateway-registered';
}

function stepInfo(
  pluginId: string,
  service: string,
  screenshots: Readonly<Record<string, Screenshot>> | undefined,
  step: GuideStep,
): ConnectStepInfo {
  const shot = step.screenshot === undefined ? undefined : screenshots?.[step.screenshot];
  return {
    do: step.do,
    path: [...(step.path ?? [])],
    url: step.url ?? null,
    code: step.code ?? null,
    figure:
      step.screenshot !== undefined && shot !== undefined
        ? {
            file: step.screenshot,
            src: connectFigureSrc(pluginId, step.screenshot),
            alt: shot.alt,
            attribution: screenshotAttribution(service, shot),
            sourceHost: screenshotSourceHost(shot),
            licence: shot.licence,
            licenceWords: screenshotLicenceWords(shot.licence),
          }
        : null,
  };
}

function credentialInfo(plugin: ProviderPlugin): CredentialInfo {
  const spec = plugin.credential;
  const manualRevocation = plugin.manualRevocation ?? null;
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
    steps: guide
      ? guide.steps.map((step) => stepInfo(plugin.id, plugin.displayName, guide.screenshots, step))
      : [],
    // A key in several shapes (Vercel: a team or one project): each with its own steps.
    alternatives:
      guide && spec.kind === 'api-key'
        ? (spec.alternatives ?? []).map((alt) => ({
            id: alt.id,
            label: alt.label,
            help: alt.help ?? null,
            steps: alt.steps.map((step) =>
              stepInfo(plugin.id, plugin.displayName, guide.screenshots, step),
            ),
          }))
        : [],
    reach: guide?.reach ?? null,
    permissions: guide
      ? guide.permissions.map((p) => ({ name: p.name, access: p.access, tools: [...p.tools] }))
      : [],
    expiry: guide?.expiry ?? null,
    docsUrl: guide?.docsUrl ?? null,
    scopes: spec.kind === 'oauth2' ? [...spec.scopes] : [],
    manualRevocation,
  };
}

/** The entity names the slices of the classified examples go through. */
function touchedEntities(examples: readonly ExampleInfo[]): Set<string> {
  const names = new Set<string>();
  for (const example of examples) {
    for (const serialized of example.slices) {
      for (const segment of parseSlice(serialized).path) {
        if (segment.kind === 'name') names.add(segment.value);
      }
    }
  }
  return names;
}

function dataModelInfo(model: DataModel, touched: ReadonlySet<string>): PluginInfo['dataModel'] {
  return {
    planes: model.planes.map((plane) => ({
      slug: plane.slug,
      description: plane.description ?? null,
      entities: plane.entities.map((entity) => ({
        name: entity.name,
        parent: entity.parent,
        cardinalities: [...entity.cardinalities],
        description: entity.description,
        carriesEnv: entity.envScopable === true,
        touched: touched.has(entity.name),
      })),
    })),
  };
}

/** Where the environment comes from, as the gateway's provider reference decides it. */
function environmentInfo(plugin: ProviderPlugin): EnvironmentInfo {
  const envs = [...new Set(plugin.catalog.risks.flatMap((r) => r.acceptable_in_envs ?? []))];
  return {
    source: envs.length === 0 ? 'none' : plugin.envOf ? 'call' : 'resource-label',
    envs,
    carriers: plugin.dataModel.planes.flatMap((plane) =>
      plane.entities.filter((e) => e.envScopable === true).map((e) => `${plane.slug}.${e.name}`),
    ),
  };
}

/**
 * The plain data the site shows of one plugin. Throws `ExampleError` when a
 * declared example does not classify onto the plugin's own catalog: the build
 * fails rather than publish a page showing what the gateway would not do.
 */
export function pluginInfo(
  plugin: ProviderPlugin,
  dir: string,
  packageName: string,
  examplesSource: string | null = null,
): PluginInfo {
  const catalog = plugin.catalog;
  const risksById = new Map(catalog.risks.map((r) => [r.id, r]));
  const order = new Map(catalog.risks.map((r, i) => [r.id, i]));
  const risks = catalog.risks.map(riskInfo);
  const all = macroActionsOf(catalog).map((action) => macroActionInfo(action, risksById, order));
  const macroActions = all.filter((action) => action.id !== ANYTHING_ELSE_MACRO_ACTION);
  const examples = classifyExamples(plugin);
  const touches = touchesByTool(examples, order);
  const excludedTools = Object.entries(plugin.excludedTools ?? {}).map(([name, reason]) => ({
    name,
    reason,
  }));
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
    excludedTools,
    docsUrl: plugin.docsUrl ?? null,
    manualRevocation: plugin.manualRevocation ?? null,
    catalogVersion: catalog.catalog_version ?? null,
    catalogDate: catalog.catalog_date ?? null,
    tools: plugin.tools.map((tool) => ({
      name: tool.name,
      title: plugin.toolTitles?.[tool.name] ?? null,
      description: tool.description,
      touches: touches.get(tool.name) ?? [],
    })),
    risks,
    anythingElse: all.find((action) => action.id === ANYTHING_ELSE_MACRO_ACTION) ?? null,
    retired: risks.filter((r) => r.deprecated).map((r) => r.id),
    macroActions,
    counts: {
      permissions: risks.filter((r) => !r.fallback && !r.deprecated).length,
      macroActions: macroActions.length,
      tools: plugin.tools.length,
      excludedTools: excludedTools.length,
      examples: examples.length,
    },
    examples,
    workedMission: workedMission(plugin),
    credentials: [credentialInfo(plugin)],
    gitRemote: plugin.gitRemote !== undefined,
    dataModel: dataModelInfo(plugin.dataModel, touchedEntities(examples)),
    environment: environmentInfo(plugin),
    examplesSource,
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
    const examples = `${dir}/src/examples.ts`;
    plugins.push(
      pluginInfo(
        plugin,
        dir,
        typeof pkg.name === 'string' ? pkg.name : dir,
        existsSync(join(repoRoot, examples)) ? examples : null,
      ),
    );
  }
  return plugins.sort((a, b) => a.id.localeCompare(b.id));
}
