/**
 * What a service's page shows, section by section (website spec §2.3, the
 * "Atlas" layout, sections 1–10), as plain data every rendering reads: the
 * HTML page (`ServicePage.tsx`, on the site and in the gateway's Reference)
 * and the site's Markdown twin (`pluginPageMarkdown`). Every sentence is a fixed
 * template over a plugin field: the words of the risk model come from
 * `@vaubaan/policy-engine` — the rows, their reasons and gate sentences, the
 * gates, the trust levels —; this module only places, counts and joins them.
 * The page never says "tier" and prints no severity word.
 */
import {
  GATE_WORDS,
  ROW_GATE_SENTENCES,
  ROW_WORDS,
  TRUST_LEVEL_BUDGET_FACTOR,
  TRUST_LEVEL_LABELS,
  TRUST_LEVELS,
  type GateWord,
  type Reason,
  type Row,
  type TrustLevel,
} from '@vaubaan/policy-engine';
import type { TokenExpiry } from '@vaubaan/plugin-sdk';
import type { DataModelCardinality } from '@vaubaan/shared';

import type { CarefulOutcome, ExampleInfo } from './examples';
import type {
  ConnectStepInfo,
  CredentialInfo,
  EnvironmentSource,
  LevelBudgets,
  MacroActionEntryInfo,
  ModelEntityInfo,
  PluginInfo,
  RiskInfo,
} from './info';

// ---------------------------------------------------------------------------
// Small words
// ---------------------------------------------------------------------------

/** "a", "a and b", "a, b and c". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function plural(n: number, one: string, other: string): string {
  return `${n} ${n === 1 ? one : other}`;
}

/** "5,000": a quota as the gateway's interface writes it. */
export function figure(n: number): string {
  return n.toLocaleString('en-US');
}

/** "a" or "an" before a word, by its first letter. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'An' : 'A';
}

/** A sentence ends with a period. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** "Careful ×1". */
export function levelHeading(level: TrustLevel): string {
  return `${TRUST_LEVEL_LABELS[level]} ×${TRUST_LEVEL_BUDGET_FACTOR[level]}`;
}

/**
 * The section numbers of the page, in order; retired permissions only when there
 * are some. `extras` are an app's own sections after connecting an account (the
 * site's health and links), numbered on.
 */
export function sectionNumbers<E extends string = never>(
  plugin: PluginInfo,
  extras: readonly E[] = [],
): Readonly<Record<SectionId | E, number>> {
  const order: (SectionId | E)[] = [
    'model',
    'macro-actions',
    'map',
    'examples',
    'anything-else',
    'tools',
    ...(plugin.retired.length > 0 ? (['retired'] as const) : []),
    'connect',
    ...extras,
  ];
  const numbers = Object.fromEntries(order.map((id, i) => [id, i + 1]));
  return { retired: 0, ...numbers } as Record<SectionId | E, number>;
}

/** The sections every rendering of the page draws, in order (`retired` only when some). */
export type SectionId =
  | 'model'
  | 'macro-actions'
  | 'map'
  | 'examples'
  | 'anything-else'
  | 'tools'
  | 'retired'
  | 'connect';

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

/** The lede: what the plugin is for, then its own description. */
export function ledeOf(plugin: PluginInfo): string {
  return `The ${plugin.name} plugin lets a Vaubaan Gateway mission use ${plugin.name} without handing the agent a credential. ${plugin.description}`.trim();
}

/** "17 permissions", "4 macro-actions", "28 tools": the counts line, the gateways added by the page. */
export function countsOf(plugin: PluginInfo): string[] {
  return [
    plural(plugin.counts.permissions, 'permission', 'permissions'),
    plural(plugin.counts.macroActions, 'macro-action', 'macro-actions'),
    plural(plugin.counts.tools, 'tool', 'tools') + (plugin.gitRemote ? ' and the git remote' : ''),
  ];
}

// ---------------------------------------------------------------------------
// 1 · The model
// ---------------------------------------------------------------------------

/** The mark of a cardinality in the diagram. */
export const CARDINALITY_MARKS: Readonly<Record<DataModelCardinality, string>> = {
  one: '1',
  bounded: 'n',
  unbounded: '*',
};

/**
 * How a cardinality reads (risk model §2.1): the gateway's service reference
 * says the same (`CARDINALITY_WORDS`, `apps/gateway/src/lib/services/reference.ts`,
 * which the site may not import; `sources-agree.test.ts` compares them).
 */
export const CARDINALITY_WORDS: Readonly<Record<DataModelCardinality, string>> = {
  one: 'exactly one, named',
  bounded: 'a finite, known set',
  unbounded: 'an unknown number, possibly all',
};

/**
 * The rule of the environment (risk model §6), as the gateway's service
 * reference says it (`ENVIRONMENT_EXPLANATIONS`; compared by `sources-agree.test.ts`).
 */
export const ENVIRONMENT_RULES: Readonly<Record<EnvironmentSource, string>> = {
  call: 'The environment is read from each call: the plugin derives it from what the call names, whatever label the resource carries. A permission tied to an environment is held once per environment, and a call counts against the one it touches.',
  'resource-label':
    'The environment is the label the owner of the account puts on each resource. A permission tied to an environment is held once per label, and is refused on a resource that has no label or a label the permission does not list.',
  none: 'No permission of this service depends on an environment: each is held once, whatever the resource.',
};

export const MODEL_SENTENCE =
  'The things that exist at the service and how they nest. Every permission is written over these; a resource of an account is one of them, named by its ref.';

export interface ModelNode {
  readonly name: string;
  readonly description: string;
  readonly marks: readonly string[];
  /** The entity a resource of an account is (named by the plugin's `resourceNoun`). */
  readonly resource: boolean;
  readonly carriesEnv: boolean;
  /** False when no classified example touches it: drawn dashed. */
  readonly touched: boolean;
  readonly children: readonly ModelNode[];
}

export interface ModelPlane {
  readonly slug: string;
  readonly description: string | null;
  readonly roots: readonly ModelNode[];
}

export interface ModelView {
  /** "1 plane, 22 things." */
  readonly counts: string;
  readonly planes: readonly ModelPlane[];
  /** The diagram said in one line, for a screen reader. */
  readonly label: string;
  /** The summary's account sentence. */
  readonly account: string | null;
  /** The summary's resource sentences. */
  readonly resource: string | null;
  /** The summary's sentences about the environment. */
  readonly environmentNotes: readonly string[];
  readonly environmentRule: string;
  readonly envs: readonly string[];
  readonly carriers: readonly string[];
  /** The model marks a carrier but no catalog entry names an environment (GitHub's branch). */
  readonly envInModelOnly: boolean;
  /** Some entity is touched by no tool: the legend says what dashed means. */
  readonly someUntouched: boolean;
}

/**
 * The entities a resource of the service is, from the plugin's `resourceNoun`:
 * each noun of it ("page or database" is two) names the entity spelled the
 * same, the entity its last word names ("library index" → `index`), or the
 * entity a one-word noun starts with ("repository" → `repo`). None without a noun.
 */
export function isResourceEntity(name: string, noun: PluginInfo['resourceNoun']): boolean {
  if (noun === null) return false;
  return noun.one.split(' or ').some((candidate) => {
    const words = candidate.trim().split(' ');
    return (
      name === candidate ||
      name === words.join('-') ||
      name === words[words.length - 1] ||
      (words.length === 1 && name.length >= 3 && candidate.startsWith(name) && !name.includes('-'))
    );
  });
}

/**
 * The plugin's summary cut in three: the account (its first clause), the
 * environment (the sentences that name it) and the resource (the rest).
 */
export function summaryParts(summary: string | null): {
  account: string | null;
  resource: string | null;
  environment: string[];
} {
  if (!summary) return { account: null, resource: null, environment: [] };
  const sentences = summary.trim().split(/(?<=[.!?])\s+(?=[A-Z`(])/);
  const [first = '', ...others] = sentences;
  const cut = first.indexOf('; ');
  const account = sentence(cut < 0 ? first : first.slice(0, cut));
  const rest = [...(cut < 0 ? [] : [capitalise(sentence(first.slice(cut + 2)))]), ...others];
  const environment = rest.filter((s) => /environment/i.test(s));
  const resource = rest.filter((s) => !/environment/i.test(s));
  return {
    account,
    resource: resource.length > 0 ? resource.join(' ') : null,
    environment,
  };
}

function nodeOf(
  entity: ModelEntityInfo,
  all: readonly ModelEntityInfo[],
  noun: PluginInfo['resourceNoun'],
): ModelNode {
  return {
    name: entity.name,
    description: entity.description,
    marks: entity.cardinalities.map((c) => CARDINALITY_MARKS[c]),
    resource: isResourceEntity(entity.name, noun),
    carriesEnv: entity.carriesEnv,
    touched: entity.touched,
    children: all.filter((e) => e.parent === entity.name).map((e) => nodeOf(e, all, noun)),
  };
}

export function modelOf(plugin: PluginInfo): ModelView {
  const planes = plugin.dataModel.planes.map((plane): ModelPlane => ({
    slug: plane.slug,
    description: plane.description,
    roots: plane.entities
      .filter((e) => e.parent === null)
      .map((e) => nodeOf(e, plane.entities, plugin.resourceNoun)),
  }));
  const things = plugin.dataModel.planes.reduce((n, p) => n + p.entities.length, 0);
  const parts = summaryParts(plugin.summary);
  const env = plugin.environment;
  return {
    counts: `${plural(planes.length, 'plane', 'planes')}, ${plural(things, 'thing', 'things')}.`,
    planes,
    label: `Diagram: ${plugin.dataModel.planes
      .map((p) => `plane ${p.slug} with ${p.entities.map((e) => e.name).join(', ')}`)
      .join('; ')}`,
    account: parts.account,
    resource: parts.resource,
    environmentNotes: parts.environment,
    environmentRule: ENVIRONMENT_RULES[env.source],
    envs: env.envs,
    carriers: env.carriers,
    envInModelOnly: env.source === 'none' && env.carriers.length > 0,
    someUntouched: plugin.dataModel.planes.some((p) => p.entities.some((e) => !e.touched)),
  };
}

// ---------------------------------------------------------------------------
// 2 · Macro-actions
// ---------------------------------------------------------------------------

export const MACRO_ACTIONS_SENTENCE =
  'A mission is made of them: the person ticks the ones the task needs and sets each to a trust level.';

export function macroActionsTitle(plugin: PluginInfo): string {
  return `What an agent does at ${plugin.name}: ${plural(plugin.macroActions.length, 'macro-action', 'macro-actions')}`;
}

// ---------------------------------------------------------------------------
// 3 · The map
// ---------------------------------------------------------------------------

/** The rows of the map, worst first. */
export const MAP_ROWS: readonly Row[] = [4, 3, 2, 1];

/** The most environments the map's toggle draws (its CSS is written for this many). */
export const ENV_TOGGLE_MAX = 6;

/** A gate in one short word, in a cell of the map; the legend gives the gateway's words beside it. */
export const GATE_SHORT: Readonly<Record<GateWord, string>> = {
  free: 'yes',
  ask: 'ask me',
  off: 'no',
};

/** What a trust level does with a permission in one environment (or in all, `env: null`). */
export interface CellValue {
  readonly level: TrustLevel;
  readonly env: string | null;
  readonly gate: GateWord;
  /** Calls a day; `null` when not included. */
  readonly quota: number | null;
  /** The catalog does not accept the permission on this environment. */
  readonly never: boolean;
}

/** What follows the gate word in a cell: " · 1,000 a day", " · never on prod", or nothing. */
export function cellSuffix(value: CellValue): string {
  if (value.never) return ` · never on ${value.env ?? ''}`;
  return value.quota === null ? '' : ` · ${figure(value.quota)} a day`;
}

/** "yes · 1,000 a day", "no", "no · never on prod". */
export function cellWords(value: CellValue): string {
  return `${GATE_SHORT[value.gate]}${cellSuffix(value)}`;
}

/** A permission in one cell of the map: one row, for some environments or all. */
export interface MapChip {
  readonly riskId: string;
  readonly label: string;
  /** The catalog's reason, in the tooltip. */
  readonly reason: string;
  readonly row: Row;
  /** The branch of the tree that put it in its row; `null` in the harmless row. */
  readonly rowReason: Reason | null;
  /** The environments this chip is drawn in; `null`: in every one (or there is no toggle). */
  readonly envs: readonly string[] | null;
  /** The catalog does not accept it on these environments: dashed. */
  readonly refused: boolean;
  /** One per trust level, and per environment of the chip when it is environment-scoped. */
  readonly values: readonly CellValue[];
}

export interface MapRowView {
  readonly row: Row;
  readonly word: string;
  /** What the trust levels do with the row (`ROW_GATE_SENTENCES`). */
  readonly gates: string;
  /** One cell per macro-action, in catalog order. */
  readonly cells: readonly (readonly MapChip[])[];
}

export interface MapSum {
  readonly level: TrustLevel;
  readonly env: string | null;
  readonly text: string;
}

export interface MapView {
  readonly columns: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string;
  }[];
  readonly rows: readonly MapRowView[];
  /** The environments of the toggle, the catalog's last-named (its production) first; empty: no toggle. */
  readonly envs: readonly string[];
  /** The intro, cut where the page names the chosen environment ("For the chosen trust level[ and environment (…)]"). */
  readonly introLead: string;
  readonly introTail: string;
  readonly sums: readonly MapSum[];
  /** What changes from one environment to another, when there is a toggle. */
  readonly notes: readonly string[];
}

/**
 * The environments of the map's toggle: only when the data model carries an
 * environment and the catalog names some; in the reverse of the order the
 * catalog first names them, so its production comes first.
 */
export function toggleEnvsOf(plugin: PluginInfo): string[] {
  const { envs, carriers } = plugin.environment;
  if (carriers.length === 0 || envs.length === 0) return [];
  return [...envs].reverse();
}

function levelValues(levels: LevelBudgets, env: string | null): CellValue[] {
  return TRUST_LEVELS.map((level) => {
    const line = levels[level];
    return {
      level,
      env,
      gate: line.gateWord,
      quota: line.gateWord === 'off' ? null : line.quota,
      never: false,
    };
  });
}

function neverValues(env: string): CellValue[] {
  return TRUST_LEVELS.map((level) => ({ level, env, gate: 'off', quota: null, never: true }));
}

/**
 * The chips of one entry: one when it is not environment-scoped (or there is no
 * toggle), else one per row and reason its environments land in — an
 * environment the catalog does not accept lands in the permission's own row, dashed.
 */
function chipsOf(entry: MacroActionEntryInfo, risk: RiskInfo, envs: readonly string[]): MapChip[] {
  const base = { riskId: risk.id, label: risk.label, reason: risk.reason };
  if (envs.length === 0 || risk.acceptableInEnvs === null) {
    return [
      {
        ...base,
        row: risk.row,
        rowReason: risk.rowReason,
        envs: null,
        refused: false,
        values: levelValues(entry.levels, null),
      },
    ];
  }
  const groups = new Map<
    string,
    { row: Row; rowReason: Reason | null; refused: boolean; envs: string[]; values: CellValue[] }
  >();
  for (const env of envs) {
    const accepted = risk.acceptableInEnvs.includes(env);
    const variant = risk.envVariants.find((v) => v.env === env);
    const levels = entry.envLevels.find((l) => l.env === env)?.levels;
    const row = accepted && variant ? variant.row : risk.row;
    const rowReason = accepted && variant ? variant.rowReason : risk.rowReason;
    const refused = !accepted || levels === undefined;
    const key = `${refused ? 'x' : 'o'}/${row}/${rowReason ?? ''}`;
    const group = groups.get(key) ?? { row, rowReason, refused, envs: [], values: [] };
    group.envs.push(env);
    group.values.push(...(refused ? neverValues(env) : levelValues(levels, env)));
    groups.set(key, group);
  }
  const single = groups.size === 1;
  return [...groups.values()].map((g) => ({
    ...base,
    row: g.row,
    rowReason: g.rowReason,
    envs: single ? null : g.envs,
    refused: g.refused,
    values: g.values,
  }));
}

function sumText(level: TrustLevel, env: string | null, counts: Record<GateWord, number>): string {
  const parts = [`${GATE_WORDS.free} ${counts.free}`, `${GATE_WORDS.ask} ${counts.ask}`];
  if (counts.off > 0) parts.push(`${GATE_WORDS.off} ${counts.off}`);
  return `${TRUST_LEVEL_LABELS[level]}${env ? ` on ${env}` : ''}: ${parts.join(', ')}.`;
}

export function mapOf(plugin: PluginInfo): MapView {
  const risks = new Map(plugin.risks.map((r) => [r.id, r]));
  const envs = toggleEnvsOf(plugin);
  // Each permission once, at its first macro-action: what the sums and notes count.
  const firstChips = new Map<string, MapChip[]>();
  const chipsByColumn = plugin.macroActions.map((action) =>
    action.entries.flatMap((entry) => {
      const risk = risks.get(entry.riskId);
      if (!risk) return [];
      const chips = chipsOf(entry, risk, envs);
      if (!firstChips.has(risk.id)) firstChips.set(risk.id, chips);
      return chips;
    }),
  );
  const rows = MAP_ROWS.map((row): MapRowView => ({
    row,
    word: ROW_WORDS[row],
    gates: ROW_GATE_SENTENCES[row],
    cells: chipsByColumn.map((chips) => chips.filter((c) => c.row === row)),
  }));
  const sums: MapSum[] = [];
  for (const level of TRUST_LEVELS) {
    for (const env of envs.length > 0 ? envs : [null]) {
      const counts: Record<GateWord, number> = { free: 0, ask: 0, off: 0 };
      for (const chips of firstChips.values()) {
        const own = chips
          .flatMap((c) => c.values)
          .find((v) => v.level === level && (v.env === null || v.env === env));
        if (own) counts[own.gate] += 1;
      }
      sums.push({ level, env, text: sumText(level, env, counts) });
    }
  }

  const notes: string[] = [];
  if (envs.length > 0) {
    const distinct = [...firstChips.values()].map((chips) => chips[0]!);
    const held = distinct.filter((c) => risks.get(c.riskId)?.acceptableInEnvs !== null);
    const once = distinct.filter((c) => risks.get(c.riskId)?.acceptableInEnvs === null);
    if (held.length > 0 && held.length <= once.length) {
      notes.push(`Held once per environment: ${held.map((c) => c.label).join('; ')}.`);
    } else if (once.length > 0) {
      notes.push(
        `Held once, whatever the ${plugin.resourceNoun?.one ?? 'resource'}: ${once.map((c) => c.label).join('; ')}. Every other permission is held once per environment.`,
      );
    }
    for (const env of envs) {
      const refused = held.filter((c) => !risks.get(c.riskId)!.acceptableInEnvs!.includes(env));
      if (refused.length > 0) {
        notes.push(`Not accepted on ${env}: ${refused.map((c) => c.label).join('; ')}.`);
      }
    }
    for (const env of envs) {
      const moved = held.filter((c) => {
        const risk = risks.get(c.riskId)!;
        const variant = risk.envVariants.find((v) => v.env === env);
        return variant !== undefined && variant.acceptable && variant.row !== risk.row;
      });
      if (moved.length > 0) {
        notes.push(`In another row on ${env}: ${moved.map((c) => c.label).join('; ')}.`);
      }
    }
  }

  const permissions = firstChips.size;
  return {
    columns: plugin.macroActions.map((a) => ({
      id: a.id,
      label: a.label,
      description: a.description,
    })),
    rows,
    envs,
    introLead: `${plural(permissions, 'permission', 'permissions')} of ${plural(plugin.macroActions.length, 'macro-action', 'macro-actions')}, in the four rows of the tree. For the chosen trust level${envs.length > 0 ? ' and environment' : ''}`,
    introTail: `, each cell gives ${GATE_SHORT.free}, ${GATE_SHORT.ask} or ${GATE_SHORT.off}, and the quota a day.`,
    sums,
    notes,
  };
}

export const DAY_NOTE =
  "Limits are counted over a mission's period: a day unless its creator picks another, or the mission's whole life for a one-off. The figures here are per day.";

/** The words of a trust level's line: the gate (when not "runs freely") and the quota a day. */
export function levelCellWords(
  levels: LevelBudgets,
  level: TrustLevel,
): { gate: GateWord; quota: string | null } {
  const line = levels[level];
  return { gate: line.gateWord, quota: line.gateWord === 'off' ? null : figure(line.quota) };
}

// ---------------------------------------------------------------------------
// 4 · A few calls
// ---------------------------------------------------------------------------

const CAREFUL_GATE: Readonly<Record<CarefulOutcome, GateWord>> = {
  runs: 'free',
  'asks-first': 'ask',
  cannot: 'off',
};

/** What a Careful mission does with the call, as a gate word. */
export function carefulGateOf(example: ExampleInfo): GateWord {
  return CAREFUL_GATE[example.atCareful.outcome];
}

/** A value of a call, shortened for a page: long strings cut, nested values kept. */
function shortValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 48 ? `${value.slice(0, 45)}…` : value;
  if (Array.isArray(value)) {
    const shown = value.slice(0, 4).map(shortValue);
    return value.length > 4 ? [...shown, `…${value.length - 4} more`] : shown;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shortValue(v)]));
  }
  return value;
}

/** `github__create_pr {"repo":"acme/web",…}` */
export function callWords(example: ExampleInfo): string {
  return `${example.tool} ${JSON.stringify(shortValue(example.args))}`;
}

export interface CallsView {
  readonly total: number;
  /** One per macro-action that has an example of its own, in catalog order, then the first refused at Careful. */
  readonly rows: readonly ExampleInfo[];
  /** The sentence before the link to the examples as code. */
  readonly intro: string;
  /** "The 42 calls, as code". */
  readonly linkLabel: string;
}

/**
 * The calls the page shows: for each macro-action, the first declared example
 * whose permissions all belong to it; then the first one Careful leaves out.
 */
export function callsOf(plugin: PluginInfo): CallsView {
  const all = plugin.examples;
  const chosen: ExampleInfo[] = [];
  for (const action of plugin.macroActions) {
    const own = new Set(action.entries.map((e) => e.riskId));
    const pick = all.find(
      (e) =>
        !chosen.includes(e) && e.permissions.length > 0 && e.permissions.every((id) => own.has(id)),
    );
    if (pick) chosen.push(pick);
  }
  const refused = all.find((e) => e.atCareful.outcome === 'cannot');
  if (refused && !chosen.includes(refused)) chosen.push(refused);
  const careful = TRUST_LEVEL_LABELS.careful;
  return {
    total: all.length,
    rows: chosen,
    intro:
      all.length === 0
        ? 'This plugin declares no example yet.'
        : `${plural(all.length, 'declared call', 'declared calls')}, run through the plugin's own classifier when this page was built; here one per macro-action${refused ? ` and the first the catalog refuses at ${careful}` : ''}.`,
    linkLabel: `The ${plural(all.length, 'call', 'calls')}, as code`,
  };
}

// ---------------------------------------------------------------------------
// 5 · Anything else
// ---------------------------------------------------------------------------

/** "A call no permission covers touches `x` instead of slipping through…" */
export function anythingElseSentence(plugin: PluginInfo): string {
  const fallback = plugin.anythingElse?.entries ?? [];
  if (fallback.length === 0) return 'This plugin has no fallback permission.';
  return `A call no permission covers touches ${listWords(fallback.map((e) => `\`${e.riskId}\``))} instead of slipping through. No macro-action holds it; a person ticks it knowingly.`;
}

export const LEFT_OUT_SENTENCE =
  'Left out on purpose — tools of the service this plugin does not expose:';

// ---------------------------------------------------------------------------
// 6 · Tools
// ---------------------------------------------------------------------------

export const TOOLS_NOTE =
  "A tool's permissions depend on its arguments, so a mission is made of the macro-actions above, not of tools.";

export function toolsIntro(plugin: PluginInfo): string {
  return `${plural(plugin.tools.length, 'tool', 'tools')}. ${TOOLS_NOTE}`;
}

export function toolsCount(plugin: PluginInfo): string {
  return `${plural(plugin.tools.length, 'tool', 'tools')} · scroll the list`;
}

// ---------------------------------------------------------------------------
// 7 · Retired permissions
// ---------------------------------------------------------------------------

export const RETIRED_SENTENCE =
  'Kept so the missions that hold them still read; no tool touches them and no new mission is offered them.';

export interface RetiredItem {
  readonly riskId: string;
  readonly label: string;
  readonly replacedBy: string | null;
}

export function retiredOf(plugin: PluginInfo): RetiredItem[] {
  const risks = new Map(plugin.risks.map((r) => [r.id, r]));
  return plugin.retired.map((id) => ({
    riskId: id,
    label: risks.get(id)?.label ?? id,
    replacedBy: risks.get(id)?.replacedBy ?? null,
  }));
}

// ---------------------------------------------------------------------------
// 8 · Connecting an account
// ---------------------------------------------------------------------------

/**
 * The docs page of the OAuth broker, as a path of the documentation site: each
 * app resolves it (`ServicePage`'s `href`), the site as it is, the gateway under
 * its `docs.url`.
 */
export const BROKER_DOC = '/docs/operations/oauth-broker';

/** The section's anchor on a service's page: where its connect guide lives. */
export const CONNECT_ANCHOR = 'connect';

/** Every step of a way of connecting: each alternative's, then the shared ones. */
export function allSteps(c: Pick<CredentialInfo, 'steps' | 'alternatives'>): ConnectStepInfo[] {
  return [...c.alternatives.flatMap((alt) => alt.steps), ...c.steps];
}

/** The expiry of a pasted key, after "Expiry:"; `escape` is the twin's Markdown escape, none for HTML. */
export function expiryText(
  expiry: TokenExpiry,
  escape: (value: string) => string = (value) => value,
): string {
  switch (expiry.kind) {
    case 'service-reports':
      return 'the service tells the gateway the date, and the account page warns before it.';
    case 'person-types':
      return `about ${expiry.recommendedDays} days, chosen at the service; the service does not tell the gateway the date.`;
    case 'none':
      return escape(expiry.reason);
  }
}

/** Under the tools of a service the gateway is also the git remote of; its link is a path of the documentation site. */
export const GIT_REMOTE_SENTENCE =
  "The instance is also the agents' git remote for this service: `git clone` and `git push` go through the gateway with the mission key, every pushed ref decided like a tool call ([git remote](/docs/missions/git-remote)).";

/** Between two menu labels of a path, in the twin. */
export const PATH_SEPARATOR = '›';

/** The legend of the alternatives' toggle. */
export const ALTERNATIVES_LEGEND = 'Choose one';

/**
 * The three ways of connecting, numbered so a reader learns there are only three
 * (website spec §2.3 item 9): the badge that opens the section, by client source.
 * An `ssh-key` way is the first kind, its key pair said by `connectSentences`.
 */
export const CONNECT_KINDS: Readonly<
  Record<
    Exclude<CredentialInfo['clientSource'], 'host'>,
    { readonly n: 1 | 2 | 3; readonly words: string }
  >
> = {
  'pasted-key': { n: 1, words: 'a key you create and paste' },
  'gateway-registered': { n: 2, words: 'you sign in and allow the gateway (its own client)' },
  broker: { n: 3, words: 'you sign in through an OAuth broker' },
};

/** "1 of 3 · a key you create and paste". */
export function connectKindBadge(c: Pick<CredentialInfo, 'clientSource'>): string {
  // The gateway's own account is none of the three: nothing comes from a service.
  if (c.clientSource === 'host') return 'One click · your own account on the gateway';
  const kind = CONNECT_KINDS[c.clientSource];
  return `${kind.n} of 3 · ${kind.words}`;
}

/** The declaration in code words, beside the badge: `api-key · fine-grained personal access token`. */
export function connectKindCode(c: CredentialInfo): string {
  switch (c.clientSource) {
    case 'host':
      return 'host';
    case 'broker':
      return `oauth2 · broker · ${c.brokerProvider ?? ''}`;
    case 'gateway-registered':
      return 'oauth2 · clientRegistration';
    case 'pasted-key':
      return c.label ? `${c.kind} · ${c.label}` : c.kind;
  }
}

/** The sentences that open the connect block: what the person does, by where the credential comes from. */
export function connectSentences(c: CredentialInfo, service: string): string[] {
  switch (c.clientSource) {
    case 'host':
      return [
        `Nothing to create or paste: one click, “Connect”, on the connect screen of ${service}. The account is the person's own place on the gateway; it holds no secret and is never shared.`,
      ];
    case 'broker':
      return [
        `${service} signs in through the client of an OAuth broker: nothing is created or pasted, the person signs in at ${service} and allows the gateway.`,
      ];
    case 'gateway-registered':
      return [
        `The person signs in at ${service} and allows the gateway; nothing is created or pasted. The gateway registers its own client at the service the first time someone connects, one per instance.`,
      ];
    case 'pasted-key': {
      if (c.kind === 'ssh-key') {
        return [
          'The instance generates a key pair; the person installs its public key on the host. Nothing secret is pasted.',
        ];
      }
      const label = c.label ?? 'key';
      return [
        `${article(label)} ${label} the person creates at ${service} and pastes once; nobody declares anything beforehand.`,
      ];
    }
  }
}

/** The heading of the permissions to grant at the service. */
export function grantsHeading(service: string): string {
  return `Permission at ${service}`;
}

/** The title of the administrator's block a brokered service opens with. */
export const BROKER_ADMIN_TITLE = 'Before anyone connects';

/** What an administrator does once, before anyone connects a brokered service. */
export function brokerAdminSentences(c: CredentialInfo, service: string): string[] {
  return [
    `The instance must be enrolled with an OAuth broker serving the service \`${c.brokerProvider ?? ''}\`; an administrator sets it up once, for everyone on the instance. Until then ${service} reads "not configured" on the connect screen.`,
    'Two ways to get one: enrol with a broker someone else operates, or run the published broker image with your own client at the service.',
    "The gateway's pages tell whether the broker is attested.",
  ];
}

/**
 * The credits of the screenshots on the plugin pages, one per documentation and
 * licence ("GitHub docs, docs.github.com (CC BY 4.0)"), generated from the
 * declarations; `null` when no page shows one taken from someone else's documentation.
 */
export function screenshotCredits(plugins: readonly PluginInfo[]): string | null {
  const credits = new Map<string, string>();
  for (const plugin of plugins) {
    for (const c of plugin.credentials) {
      for (const step of allSteps(c)) {
        const shot = step.figure;
        if (!shot || shot.sourceHost === null || shot.licence === 'ours') continue;
        const key = `${shot.sourceHost} ${shot.licence}`;
        if (!credits.has(key)) {
          credits.set(key, `${plugin.name} docs, ${shot.sourceHost} (${shot.licenceWords})`);
        }
      }
    }
  }
  if (credits.size === 0) return null;
  return `Screenshots on these pages come from the services' own documentation where its licence allows it: ${listWords([...credits.values()])}.`;
}
