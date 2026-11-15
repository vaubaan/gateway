/**
 * The worked examples of a plugin page (website spec §2.3 item 5):
 * the plugin's declared `examples` run through its own `classify` when the
 * site is built, the slices matched against its catalog by the policy
 * engine's matcher, and what a Careful mission with the plugin's first two
 * macro-actions does with each call — expanded and decided by the policy
 * engine, as the gateway expands and decides it (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05). Nothing here
 * writes a slice, a gate or a budget by hand.
 *
 * The build fails, as the plugin test kit fails, when a sample's slice lands
 * only on the fallback (a missing catalog entry), when no catalog entry
 * matches it, or when `classify` refuses a sample that did not expect it.
 */
import type { ServicePlugin, Resource, SampleCall } from '@vaubaan/plugin-sdk';
import {
  envResolverFor,
  evaluateCall,
  expandAtTrustLevel,
  indexCatalog,
  isAcceptableInEnv,
  isEnvScopedEntry,
  qualifyRiskId,
  resolveVector,
  risksTouchedBy,
  risksTouchedByAll,
  serializeSlice,
  rowOf,
  TRUST_LEVEL_GATES,
  unqualifyRiskId,
  type IndexedRiskCatalog,
  type TrustLevel,
  type TrustLevelCandidate,
} from '@vaubaan/policy-engine';
import type { Gate, RiskId, Slice } from '@vaubaan/shared';
import { parseRiskId } from '@vaubaan/shared/risk-id';

/** The trust level of the worked mission: the lowest, where a new macro-action starts. */
export const WORKED_TRUST_LEVEL: TrustLevel = 'careful';

/** How many macro-actions, from the first in catalog order, the worked mission ticks. */
export const WORKED_MACRO_ACTIONS = 2;

/** What the worked mission does with a call. */
export type WorkedOutcome = 'runs' | 'asks-first' | 'refused-not-held';

export interface WorkedDecision {
  readonly outcome: WorkedOutcome;
  /** The permissions (as the mission holds them, env-qualified) the call needs and the mission lacks. */
  readonly missing: readonly RiskId[];
  /** The permissions the call touches whose line asks first. */
  readonly asking: readonly RiskId[];
}

/** What a Careful mission holding exactly what a call touches does with it. */
export type CarefulOutcome = 'runs' | 'asks-first' | 'cannot';

/** The gate Careful gives one permission a call touches: `null` when Careful leaves it out. */
export interface CarefulGate {
  /** Qualified with the call's environment when the permission is environment-scoped. */
  readonly riskId: RiskId;
  readonly gate: Gate | null;
}

export interface CarefulDecision {
  readonly outcome: CarefulOutcome;
  /** One per permission the call touches, in the order the policy engine reports them. */
  readonly gates: readonly CarefulGate[];
}

export interface ExampleInfo {
  readonly tool: string;
  /** The tool's title when the plugin gives one, else its name. */
  readonly title: string;
  /** 1-based rank of this sample among the samples of its tool. */
  readonly sample: number;
  readonly args: Readonly<Record<string, unknown>>;
  /** The slices `classify` emitted, serialized. */
  readonly slices: readonly string[];
  /** The catalog permissions the slices touch, unqualified, catalog order. */
  readonly permissions: readonly RiskId[];
  /** "What a Careful mission does": each permission touched at Careful, by the policy engine. */
  readonly atCareful: CarefulDecision;
  /** What the worked mission (`/plugins.json` only since the Atlas page) does with this call. */
  readonly inWorkedMission: WorkedDecision;
}

/** One line of the worked mission, as the policy engine wrote it. */
export interface WorkedLine {
  readonly riskId: RiskId;
  readonly gate: Gate;
  readonly row: number;
  readonly quota: number;
  readonly rateMax: number;
  readonly rateWindowSeconds: number;
}

/**
 * The first two macro-actions at Careful, over every environment the catalog
 * names: the lines the policy engine writes, and the same read as the
 * gateway's mission page reads them (Can / Asks first / Cannot, `ALLOW_WORDS`).
 */
export interface WorkedMission {
  readonly trustLevel: TrustLevel;
  readonly macroActions: readonly string[];
  readonly lines: readonly WorkedLine[];
  readonly leftOut: readonly { readonly riskId: RiskId; readonly row: number }[];
  /** Lines whose gate is `auto`. */
  readonly can: readonly RiskId[];
  /** Lines whose gate is `approval`. */
  readonly asksFirst: readonly RiskId[];
  /** What Careful leaves out. */
  readonly cannot: readonly RiskId[];
}

export class ExampleError extends Error {
  constructor(pluginId: string, findings: readonly string[]) {
    super(
      `plugin '${pluginId}': its examples do not classify as its page would show them:\n` +
        findings.map((f) => `  - ${f}`).join('\n'),
    );
    this.name = 'ExampleError';
  }
}

/** The candidates of the worked macro-actions, each env-scoped entry once per environment. */
function workedCandidates(
  plugin: ServicePlugin,
  envs: readonly string[] | 'acceptable',
): TrustLevelCandidate[] {
  const byId = new Map(plugin.catalog.risks.map((r) => [r.id, r]));
  const seen = new Set<RiskId>();
  const out: TrustLevelCandidate[] = [];
  const push = (candidate: TrustLevelCandidate): void => {
    if (seen.has(candidate.risk_id)) return;
    seen.add(candidate.risk_id);
    out.push(candidate);
  };
  for (const action of (plugin.catalog.macro_actions ?? []).slice(0, WORKED_MACRO_ACTIONS)) {
    for (const entry of action.entries) {
      const risk = byId.get(entry.risk_id);
      // A retired permission is not offered, as the gateway's form leaves it out.
      if (risk === undefined || risk.deprecated === true) continue;
      const base = { quota: entry.quota, rate_limit: entry.rate_limit };
      const ceiling = risk.infra_limits?.calls_per_minute_max ?? null;
      if (!isEnvScopedEntry(risk)) {
        push({ risk_id: risk.id, vector: risk.vector, base, rate_ceiling_per_minute: ceiling });
        continue;
      }
      const reach = envs === 'acceptable' ? (risk.acceptable_in_envs ?? []) : envs;
      for (const env of reach) {
        if (!isAcceptableInEnv(risk, env)) continue;
        push({
          risk_id: qualifyRiskId(risk.id, env, risk),
          vector: resolveVector(risk, env),
          base,
          rate_ceiling_per_minute: ceiling,
        });
      }
    }
  }
  return out;
}

function expand(plugin: ServicePlugin, envs: readonly string[] | 'acceptable'): WorkedMission {
  const expansion = expandAtTrustLevel(workedCandidates(plugin, envs), WORKED_TRUST_LEVEL);
  const withGate = (gate: Gate): RiskId[] =>
    expansion.lines.filter((line) => line.gate === gate).map((line) => line.risk_id);
  return {
    trustLevel: WORKED_TRUST_LEVEL,
    macroActions: (plugin.catalog.macro_actions ?? [])
      .slice(0, WORKED_MACRO_ACTIONS)
      .map((a) => a.id),
    lines: expansion.lines.map((line) => ({
      riskId: line.risk_id,
      gate: line.gate,
      row: line.row,
      quota: line.quota,
      rateMax: line.rate_limit.max,
      rateWindowSeconds: line.rate_limit.window_seconds,
    })),
    leftOut: expansion.left_out.map((l) => ({ riskId: l.risk_id, row: l.row })),
    can: withGate('auto'),
    asksFirst: withGate('approval'),
    cannot: expansion.left_out.map((l) => l.risk_id),
  };
}

/** The worked mission, written out in `/plugins.json` (the Atlas page no longer shows it). */
export function workedMission(plugin: ServicePlugin): WorkedMission {
  return expand(plugin, 'acceptable');
}

/** The environments a call reaches: its resources' labels and what the slices resolve to. */
function envsOf(
  slices: readonly Slice[],
  resources: readonly Resource[],
  resolve: (slice: Slice) => string | null,
): string[] {
  const envs = new Set<string>();
  for (const r of resources) if (r.env) envs.add(r.env);
  for (const slice of slices) {
    const env = resolve(slice);
    if (env !== null) envs.add(env);
  }
  return [...envs];
}

/** What a Careful mission on this call's resources does with it, decided by `evaluateCall`. */
function decide(
  plugin: ServicePlugin,
  indexed: IndexedRiskCatalog,
  slices: readonly Slice[],
  resources: readonly Resource[],
): WorkedDecision {
  const resolver = envResolverFor(resources, (slice, r) => plugin.envOf?.(slice, r));
  const mission = expand(
    plugin,
    envsOf(slices, resources, (s) => resolver.resolveEnv(s)),
  );
  const gates = new Map(mission.lines.map((line) => [line.riskId, line.gate]));
  const decision = evaluateCall({
    executed_slices: slices,
    accepted_risks: new Set(gates.keys()),
    catalog: indexed,
    envResolver: resolver,
  });
  if (decision.outcome === 'denied') {
    return { outcome: 'refused-not-held', missing: [...decision.missing_risks], asking: [] };
  }
  const asking = decision.risks_touched.filter((id) => gates.get(id) === 'approval');
  return { outcome: asking.length > 0 ? 'asks-first' : 'runs', missing: [], asking };
}

/**
 * What a Careful mission holding exactly the permissions this call touches
 * does with it: `evaluateCall` against an empty mission names every touched
 * permission (env-qualified, as the gateway stores them), and Careful's gate
 * for each comes from its row in that environment. A permission refused in
 * that environment (`acceptable_in_envs`) no mission holds: `null`.
 */
function atCareful(
  plugin: ServicePlugin,
  indexed: IndexedRiskCatalog,
  slices: readonly Slice[],
  resources: readonly Resource[],
): CarefulDecision {
  const byId = new Map(plugin.catalog.risks.map((r) => [r.id, r]));
  const resolver = envResolverFor(resources, (slice, r) => plugin.envOf?.(slice, r));
  const decision = evaluateCall({
    executed_slices: slices,
    accepted_risks: new Set(),
    catalog: indexed,
    envResolver: resolver,
  });
  const touched = decision.outcome === 'denied' ? decision.missing_risks : decision.risks_touched;
  const gates = touched.map((riskId): CarefulGate => {
    const entry = byId.get(unqualifyRiskId(riskId));
    const env = parseRiskId(riskId)?.env ?? null;
    if (entry === undefined || !isAcceptableInEnv(entry, env)) return { riskId, gate: null };
    return {
      riskId,
      gate: TRUST_LEVEL_GATES[WORKED_TRUST_LEVEL][rowOf(resolveVector(entry, env))],
    };
  });
  const outcome: CarefulOutcome = gates.some((g) => g.gate === null)
    ? 'cannot'
    : gates.some((g) => g.gate === 'approval')
      ? 'asks-first'
      : 'runs';
  return { outcome, gates };
}

/** The findings on one emitted slice: it matches a catalog entry other than the fallback. */
function sliceFindings(indexed: IndexedRiskCatalog, slice: Slice, where: string): string[] {
  const fallbacks = new Set(indexed.entries.filter((e) => e.fallback).map((e) => e.entry.id));
  const risks = risksTouchedBy(slice, indexed);
  const shown = serializeSlice(slice);
  if (risks.length === 0) return [`${where}: '${shown}' matches no catalog entry`];
  if (risks.every((id) => fallbacks.has(id))) {
    return [`${where}: '${shown}' lands only on the fallback (a catalog entry is missing)`];
  }
  return [];
}

function titleOf(plugin: ServicePlugin, tool: string): string {
  return plugin.toolTitles?.[tool] ?? tool;
}

/**
 * The worked examples of a plugin, in the order it declares them. A sample
 * the plugin expects its classifier to refuse is a test of the refusal, not
 * a call the page shows: it is checked (it must be refused) and left out.
 * Throws `ExampleError` with every finding when one sample fails.
 */
export function classifyExamples(plugin: ServicePlugin): ExampleInfo[] {
  const indexed = indexCatalog(plugin.catalog);
  const findings: string[] = [];
  const examples: ExampleInfo[] = [];
  for (const [tool, calls] of Object.entries(plugin.examples ?? {})) {
    calls.forEach((sample: SampleCall, i) => {
      const where = `'${tool}' sample #${i + 1}`;
      const resources = sample.resources ?? [];
      const outcome = plugin.classify(tool, sample.args, resources);
      if ('denied' in outcome) {
        if (!sample.expectDenied)
          findings.push(`${where}: classify refused it (${outcome.denied})`);
        return;
      }
      if (sample.expectDenied) {
        findings.push(
          `${where}: expected classify to refuse it, got ${outcome.slices.length} slice(s)`,
        );
        return;
      }
      if (outcome.slices.length === 0) {
        findings.push(`${where}: classify returned no slice`);
        return;
      }
      const sliceIssues = outcome.slices.flatMap((slice, s) =>
        sliceFindings(indexed, slice, `${where} slice #${s + 1}`),
      );
      if (sliceIssues.length > 0) {
        findings.push(...sliceIssues);
        return;
      }
      examples.push({
        tool,
        title: titleOf(plugin, tool),
        sample: i + 1,
        args: sample.args,
        slices: outcome.slices.map(serializeSlice),
        permissions: risksTouchedByAll(outcome.slices, indexed),
        atCareful: atCareful(plugin, indexed, outcome.slices, resources),
        inWorkedMission: decide(plugin, indexed, outcome.slices, resources),
      });
    });
  }
  if (findings.length > 0) throw new ExampleError(plugin.id, findings);
  return examples;
}
