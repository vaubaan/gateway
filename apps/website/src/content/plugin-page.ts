/**
 * What a plugin page shows, section by section (website spec §2.3, 1–8),
 * as plain data both renderings read: the HTML page
 * (`components/plugin/PluginPage.tsx`) and its Markdown twin
 * (`pluginPageMarkdown` in `plugin-pages.ts`). Every word of the risk model
 * comes from `@vaubaan/policy-engine` — the undo rows, the gates, the trust
 * levels, the six facts —; this module only places, counts and joins them.
 * The page never says the word the trust levels read (spec §2.3): the undo
 * row words carry it.
 */
import {
  ALLOW_WORDS,
  GATE_WORDS,
  gateWordOf,
  SEVERITY_LEVELS,
  TRUST_LEVEL_BUDGET_FACTOR,
  TRUST_LEVEL_GATES,
  TRUST_LEVEL_HINTS,
  TRUST_LEVEL_LABELS,
  TRUST_LEVELS,
  UNDO_ROW_WORDS,
  unqualifyRiskId,
  WHY_LABELS,
  WHY_ORDER,
  type GateWord,
  type Tier,
  type TrustLevel,
} from '@vaubaan/policy-engine';
import { parseRiskId } from '@vaubaan/shared/risk-id';

import type { CarefulOutcome, ExampleInfo } from './plugin-examples';
import type {
  CredentialInfo,
  FactInfo,
  LevelBudgets,
  MacroActionEntryInfo,
  MacroActionInfo,
  PluginInfo,
  RiskInfo,
  Severity,
} from './plugins';

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

function plural(n: number, one: string, other: string): string {
  return `${n} ${n === 1 ? one : other}`;
}

/** "5,000": a quota as the gateway's interface writes it. */
export function figure(n: number): string {
  return n.toLocaleString('en-US');
}

function windowWords(seconds: number): string {
  if (seconds === 60) return 'a minute';
  if (seconds === 3600) return 'an hour';
  if (seconds === 86400) return 'a day';
  return `per ${seconds} seconds`;
}

/** The gate a trust level gives a permission of this kind, as the word class drawn. */
function gateWordAt(level: TrustLevel, tier: Tier): GateWord {
  const gate = TRUST_LEVEL_GATES[level][tier];
  return gate === null ? 'off' : gateWordOf(gate);
}

// ---------------------------------------------------------------------------
// 1 · Opening
// ---------------------------------------------------------------------------

export interface Opening {
  readonly title: string;
  /** "What an agent does in GitHub, in 4 macro-actions: Read, Propose, Ship and Administer." */
  readonly verbs: string;
  /** "17 permissions", "4 macro-actions", "28 tools". */
  readonly counts: readonly string[];
  /** The three dimensions of the page, each a term and a line. */
  readonly dimensions: readonly { readonly term: string; readonly line: string }[];
  /** One line per trust level: its label, its multiplier and what it does. */
  readonly levels: readonly {
    readonly label: string;
    readonly factor: number;
    readonly hint: string;
  }[];
}

export function openingOf(plugin: PluginInfo): Opening {
  const labels = plugin.macroActions.map((a) => a.label);
  const n = labels.length;
  return {
    title: `${plugin.name} plugin`,
    verbs:
      n === 0
        ? `${plugin.name} declares no macro-action yet.`
        : `What an agent does in ${plugin.name}, in ${plural(n, 'macro-action', 'macro-actions')}: ${listWords(labels)}.`,
    counts: [
      plural(plugin.counts.permissions, 'permission', 'permissions'),
      plural(plugin.counts.macroActions, 'macro-action', 'macro-actions'),
      plural(plugin.counts.tools, 'tool', 'tools') +
        (plugin.gitRemote ? ' and the git remote' : ''),
    ],
    dimensions: [
      {
        term: 'Risk',
        line: `six facts per permission — ${listWords(WHY_ORDER.map((axis) => WHY_LABELS[axis].toLowerCase()))} — summed into one word, ${listWords([...SEVERITY_LEVELS])}. The word orders; the undo fact and what makes a permission sensitive decide the gate.`,
      },
      {
        term: 'Macro-actions',
        line: `the verbs of the service${n > 0 ? ` (${listWords(labels)})` : ''}. A mission is made of them: the person ticks the ones the task needs and sets each to a trust level.`,
      },
      {
        term: 'Trust',
        line: `${listWords(TRUST_LEVELS.map((l) => TRUST_LEVEL_LABELS[l]))}, set per macro-action. From the undo fact it decides whether a permission runs freely, asks first or is left out, and multiplies the limits.`,
      },
    ],
    levels: TRUST_LEVELS.map((level) => ({
      label: TRUST_LEVEL_LABELS[level],
      factor: TRUST_LEVEL_BUDGET_FACTOR[level],
      hint: TRUST_LEVEL_HINTS[level],
    })),
  };
}

// ---------------------------------------------------------------------------
// 2 · The map
// ---------------------------------------------------------------------------

/** The rows of the map, worst first. */
export const MAP_ROWS: readonly Tier[] = [4, 3, 2, 1];

/** A permission on the map: one box, once per environment when it is environment-scoped. */
export interface PermissionBox {
  readonly riskId: string;
  readonly label: string;
  readonly severity: Severity;
  /**
   * The environments of this box, for an environment-scoped permission: one
   * box per row it lands in, so the environments that share a row (and a
   * risk word) share the box. Empty for a permission without environments.
   */
  readonly envs: readonly string[];
  readonly row: Tier;
  /** The fallback, in "Anything else": drawn dashed, never counted. */
  readonly fallback: boolean;
  /** The facts that move the gate, in words (`whole account`), for the sensitive row. */
  readonly sensitiveBy: readonly string[];
}

export interface MapColumn {
  readonly id: string;
  readonly label: string;
  /** Distinct permissions in the column. */
  readonly count: number;
  /** "Anything else", added by the gateway. */
  readonly byGateway: boolean;
}

/** What one trust level does with a row. */
export interface RowLevel {
  readonly level: TrustLevel;
  readonly label: string;
  readonly gate: GateWord;
}

export interface MapRow {
  readonly row: Tier;
  /** The undo word of the row (`impossible`, `easy, but sensitive`). */
  readonly word: string;
  readonly levels: readonly RowLevel[];
  /** "runs freely at every level", "not included at Careful, ask me first at Trusting and Autonomous". */
  readonly levelsSentence: string;
  /** For the sensitive row: what makes its permissions sensitive, in words. */
  readonly sensitiveBy: readonly string[];
  /** One cell per column, in column order. */
  readonly cells: readonly (readonly PermissionBox[])[];
}

export interface PluginMap {
  readonly columns: readonly MapColumn[];
  readonly rows: readonly MapRow[];
  /** Distinct permissions on the map, the fallback left out. */
  readonly permissions: number;
  /** Places on the map, the fallback left out: a permission counts once per environment. */
  readonly boxes: number;
  readonly envScoped: boolean;
  readonly reading: string;
}

function boxesOf(entry: MacroActionEntryInfo, risk: RiskInfo): PermissionBox[] {
  const box = (
    envs: readonly string[],
    severity: Severity,
    row: Tier,
    facts: readonly FactInfo[],
  ): PermissionBox => ({
    riskId: risk.id,
    label: risk.label,
    severity,
    envs,
    row,
    fallback: risk.fallback,
    sensitiveBy: row === 2 ? facts.filter((f) => f.movesGate).map((f) => f.word) : [],
  });
  if (entry.envLevels.length === 0) return [box([], risk.severity, risk.tier, risk.facts)];
  const merged = new Map<string, PermissionBox>();
  for (const { env } of entry.envLevels) {
    const variant = risk.envVariants.find((v) => v.env === env);
    if (!variant) continue;
    const key = `${variant.tier}/${variant.severity}`;
    const known = merged.get(key);
    merged.set(
      key,
      known
        ? { ...known, envs: [...known.envs, env] }
        : box([env], variant.severity, variant.tier, variant.facts),
    );
  }
  return [...merged.values()];
}

/** "runs freely at every level" — the levels grouped by the gate they give, in level order. */
export function levelsSentence(levels: readonly RowLevel[]): string {
  const groups: { gate: GateWord; labels: string[] }[] = [];
  for (const l of levels) {
    const group = groups.find((g) => g.gate === l.gate);
    if (group) group.labels.push(l.label);
    else groups.push({ gate: l.gate, labels: [l.label] });
  }
  if (groups.length === 1) return `${GATE_WORDS[groups[0]!.gate]} at every level`;
  return groups.map((g) => `${GATE_WORDS[g.gate]} at ${listWords(g.labels)}`).join(', ');
}

function rowLevels(row: Tier): RowLevel[] {
  return TRUST_LEVELS.map((level) => ({
    level,
    label: TRUST_LEVEL_LABELS[level],
    gate: gateWordAt(level, row),
  }));
}

/** The macro-actions as columns, then "Anything else" when the catalog has a fallback. */
function columnsOf(plugin: PluginInfo): MacroActionInfo[] {
  return plugin.anythingElse
    ? [...plugin.macroActions, plugin.anythingElse]
    : [...plugin.macroActions];
}

export function mapOf(plugin: PluginInfo): PluginMap {
  const risks = new Map(plugin.risks.map((r) => [r.id, r]));
  const actions = columnsOf(plugin);
  const boxesByColumn = actions.map((action) =>
    action.entries.flatMap((entry) => {
      const risk = risks.get(entry.riskId);
      return risk ? boxesOf(entry, risk) : [];
    }),
  );
  const columns = actions.map((action, i): MapColumn => ({
    id: action.id,
    label: action.label,
    count: new Set(boxesByColumn[i]!.map((b) => b.riskId)).size,
    byGateway: action === plugin.anythingElse,
  }));
  const rows = MAP_ROWS.map((row): MapRow => {
    const cells = boxesByColumn.map((boxes) => boxes.filter((b) => b.row === row));
    const levels = rowLevels(row);
    return {
      row,
      word: UNDO_ROW_WORDS[row],
      levels,
      levelsSentence: levelsSentence(levels),
      sensitiveBy: [...new Set(cells.flat().flatMap((b) => b.sensitiveBy))],
      cells,
    };
  });
  // A permission in two macro-actions is two boxes, one place in the counts; an
  // environment-scoped one counts once per environment.
  const places = new Map<string, Tier>();
  for (const b of boxesByColumn.flat()) {
    if (b.fallback) continue;
    for (const env of b.envs.length > 0 ? b.envs : ['']) places.set(`${b.riskId}[${env}]`, b.row);
  }
  const envScoped = boxesByColumn.flat().some((b) => b.envs.length > 0);
  return {
    columns,
    rows,
    permissions: new Set([...places.keys()].map((k) => k.slice(0, k.indexOf('[')))).size,
    boxes: places.size,
    envScoped,
    reading: readingOf([...places.values()], envScoped),
  };
}

/**
 * The sentence that reads the map, computed from its counts: how many sit in
 * each undo row, then what each trust level does with them.
 */
export function readingOf(rows: readonly Tier[], envScoped: boolean): string {
  const total = rows.length;
  if (total === 0) return 'No permission of this plugin is held by a macro-action yet.';
  const noun = envScoped
    ? `${total === 1 ? 'permission' : 'permissions'}, counted once per environment`
    : total === 1
      ? 'permission'
      : 'permissions';
  const byRow = MAP_ROWS.map((row) => ({ row, n: rows.filter((r) => r === row).length })).filter(
    (r) => r.n > 0,
  );
  const undo = byRow
    .slice()
    .reverse()
    .map((r) => `${UNDO_ROW_WORDS[r.row]} for ${r.n}`);
  const levels = TRUST_LEVELS.map((level) => {
    const counts = (['free', 'ask', 'off'] as const)
      .map((gate) => ({
        gate,
        n: byRow.filter((r) => gateWordAt(level, r.row) === gate).reduce((s, r) => s + r.n, 0),
      }))
      .filter((c) => c.n > 0)
      .map((c) => `${GATE_WORDS[c.gate]} ${c.n}`);
    return `${TRUST_LEVEL_LABELS[level]}: ${counts.join(', ')}`;
  });
  return `Of the ${total} ${noun}, undo is ${undo.join('; ')}. ${levels.join('; ')}.`;
}

/** The map restricted to one macro-action's column: what a spread shows beside its table. */
export function columnOf(map: PluginMap, actionId: string): readonly MapRow[] {
  const i = map.columns.findIndex((c) => c.id === actionId);
  return map.rows.map((row) => {
    const cell = i < 0 ? [] : (row.cells[i] ?? []);
    return {
      ...row,
      cells: [cell],
      sensitiveBy: [...new Set(cell.flatMap((b) => b.sensitiveBy))],
    };
  });
}

// ---------------------------------------------------------------------------
// 3 · One spread per macro-action
// ---------------------------------------------------------------------------

/** One line of a spread's table: a permission, in one environment when it is scoped. */
export interface SpreadLine {
  readonly riskId: string;
  readonly label: string;
  readonly reason: string;
  readonly env: string | null;
  readonly facts: readonly FactInfo[];
  readonly severity: Severity;
  readonly levels: LevelBudgets;
}

export interface Spread {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly narrative: string | null;
  readonly lines: readonly SpreadLine[];
  /** The column headings for the trust levels: "Careful ×1 · a day". */
  readonly levelHeadings: readonly { readonly level: TrustLevel; readonly heading: string }[];
  /** Limits per day, the period note, the rates and the service's ceilings. */
  readonly limitsNote: string;
  readonly column: readonly MapRow[];
}

export const DAY_NOTE =
  "Limits are counted over a mission's period: a day unless its creator picks another, or the mission's whole life for a one-off. The figures here are per day.";

export function levelHeadings(): Spread['levelHeadings'] {
  return TRUST_LEVELS.map((level) => ({
    level,
    heading: `${TRUST_LEVEL_LABELS[level]} ×${TRUST_LEVEL_BUDGET_FACTOR[level]} · a day`,
  }));
}

function spreadLines(action: MacroActionInfo, risks: ReadonlyMap<string, RiskInfo>): SpreadLine[] {
  return action.entries.flatMap((entry) => {
    const risk = risks.get(entry.riskId);
    if (!risk) return [];
    const line = (
      env: string | null,
      facts: readonly FactInfo[],
      severity: Severity,
      levels: LevelBudgets,
    ) => ({
      riskId: risk.id,
      label: risk.label,
      reason: risk.reason,
      env,
      facts,
      severity,
      levels,
    });
    if (entry.envLevels.length === 0) return [line(null, risk.facts, risk.severity, entry.levels)];
    return entry.envLevels.flatMap(({ env, levels }) => {
      const variant = risk.envVariants.find((v) => v.env === env);
      return variant ? [line(env, variant.facts, variant.severity, levels)] : [];
    });
  });
}

/** The rates of a macro-action at Careful, grouped, and the service's per-minute ceilings. */
export function limitsNote(action: MacroActionInfo, risks: ReadonlyMap<string, RiskInfo>): string {
  const groups = new Map<string, string[]>();
  for (const entry of action.entries) {
    const key = `${figure(entry.levels.careful.rateMax)} ${windowWords(entry.levels.careful.rateWindowSeconds)}`;
    const label = risks.get(entry.riskId)?.label ?? entry.riskId;
    groups.set(key, [...(groups.get(key) ?? []), label]);
  }
  const rates = [...groups].map(([rate, labels]) => `${rate} on ${listWords(labels)}`);
  const ceilings = action.entries.flatMap((entry) => {
    const ceiling = risks.get(entry.riskId)?.rateCeilingPerMinute ?? null;
    return ceiling === null
      ? []
      : [`${figure(ceiling)} a minute on ${risks.get(entry.riskId)?.label ?? entry.riskId}`];
  });
  const parts = [DAY_NOTE];
  if (rates.length > 0) {
    parts.push(
      `At ${TRUST_LEVEL_LABELS.careful} a call also runs at most ${rates.join('; ')}; the other levels multiply these rates as they multiply the limits.`,
    );
  }
  if (ceilings.length > 0) {
    parts.push(`The service's own ceiling, which no mission raises: ${ceilings.join('; ')}.`);
  }
  parts.push('A tinted fact is the one that moves the gate.');
  return parts.join(' ');
}

export function spreadsOf(plugin: PluginInfo, map: PluginMap = mapOf(plugin)): Spread[] {
  const risks = new Map(plugin.risks.map((r) => [r.id, r]));
  return plugin.macroActions.map((action) => ({
    id: action.id,
    label: action.label,
    description: action.description,
    narrative: action.narrative,
    lines: spreadLines(action, risks),
    levelHeadings: levelHeadings(),
    limitsNote: limitsNote(action, risks),
    column: columnOf(map, action.id),
  }));
}

/** The words of a trust level's cell: the gate (when not "runs freely") and the quota a day. */
export function levelCellWords(
  levels: LevelBudgets,
  level: TrustLevel,
): { gate: GateWord; quota: string | null } {
  const line = levels[level];
  return { gate: line.gateWord, quota: line.gateWord === 'off' ? null : figure(line.quota) };
}

// ---------------------------------------------------------------------------
// 4 · Worked examples
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

// ---------------------------------------------------------------------------
// 6 · A mission, worked out
// ---------------------------------------------------------------------------

export interface MissionItem {
  readonly riskId: string;
  readonly label: string;
  readonly env: string | null;
}

export interface MissionWorkedOut {
  readonly intro: string;
  readonly groups: readonly {
    readonly key: 'can' | 'asks' | 'cannot';
    readonly heading: string;
    readonly items: readonly MissionItem[];
  }[];
  /** True when Careful leaves every permission of the mission out (Context7). */
  readonly nothingRuns: boolean;
  /** What the mission does not tick, in words, or null. */
  readonly notTicked: string | null;
}

export function missionOf(plugin: PluginInfo): MissionWorkedOut {
  const labels = new Map(plugin.risks.map((r) => [r.id, r.label]));
  const item = (riskId: string): MissionItem => ({
    riskId,
    label: labels.get(unqualifyRiskId(riskId)) ?? riskId,
    env: parseRiskId(riskId)?.env ?? null,
  });
  const mission = plugin.workedMission;
  const ticked = plugin.macroActions.filter((a) => mission.macroActions.includes(a.id));
  const others = plugin.macroActions.filter((a) => !mission.macroActions.includes(a.id));
  const level = TRUST_LEVEL_LABELS[mission.trustLevel];
  const nothingRuns = mission.can.length === 0 && mission.asksFirst.length === 0;
  const lines = mission.can.length + mission.asksFirst.length + mission.cannot.length;
  return {
    intro:
      ticked.length === 0
        ? `${plugin.name} has no macro-action to tick.`
        : `Tick ${listWords(ticked.map((a) => a.label))} at ${level}: the policy engine writes the explicit list the person sees before issuing, ${plural(lines, 'permission', 'permissions')} summed up here.` +
          (nothingRuns
            ? ` At ${level} this mission can do nothing: every permission it would hold is left out, so it needs a higher trust level.`
            : ''),
    groups: [
      { key: 'can', heading: ALLOW_WORDS.can, items: mission.can.map(item) },
      { key: 'asks', heading: ALLOW_WORDS.asks, items: mission.asksFirst.map(item) },
      { key: 'cannot', heading: ALLOW_WORDS.cannot, items: mission.cannot.map(item) },
    ],
    nothingRuns,
    notTicked:
      others.length === 0
        ? null
        : `Not ticked, so not part of the mission: ${listWords(others.map((a) => a.label))}.`,
  };
}

// ---------------------------------------------------------------------------
// 7 · Connecting an account
// ---------------------------------------------------------------------------

export const BROKER_DOC = '/docs/operations/oauth-broker';

/** The sentences that open the connect block, by where the credential comes from. */
export function connectSentences(c: CredentialInfo, service: string): string[] {
  switch (c.clientSource) {
    case 'broker':
      return [
        `${service} signs in through the client of an OAuth broker: nothing is created or pasted, the person signs in at the service.`,
        `The instance must be enrolled with an OAuth broker serving the provider \`${c.brokerProvider ?? ''}\`; an administrator sets it up once, for everyone on the instance. The gateway's pages tell whether the broker is attested.`,
        'Two ways to get one: enrol with a broker someone else operates, or run the published broker image with your own client at the provider.',
      ];
    case 'gateway-registered':
      return [
        `The person signs in at ${service} and allows the gateway; nothing is created or pasted. The gateway registers its own client at the service the first time someone connects, one per instance.`,
      ];
    case 'pasted-key':
      return c.kind === 'ssh-key'
        ? [
            'The instance generates a key pair; the person installs its public key on the host. Nothing secret is pasted.',
          ]
        : [
            `A ${c.label ?? 'key'} the person creates at ${service} and pastes once; nobody declares anything beforehand. Grant everything below: each mission narrows what an agent may do.`,
          ];
  }
}

// ---------------------------------------------------------------------------
// 8 · Retired, tools, links
// ---------------------------------------------------------------------------

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

export const TOOLS_NOTE =
  "A tool's permissions depend on its arguments, so a mission is made of the macro-actions above, not of tools.";
