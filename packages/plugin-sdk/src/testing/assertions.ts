/**
 * Structural assertions every plugin test suite runs.
 *
 * Spec : docs/spec/vaubaan-gateway.md §10 — each plugin's classifier is
 * unit-tested ("a classification error is a security hole") ; every risk
 * but the fallback belongs to one macro-action of its own catalog ; no
 * wildcard anywhere. Framework-agnostic : each assertion throws a plain
 * `PluginAssertionError` listing every finding, so it works under vitest,
 * node:test or a CI script.
 */

import {
  carriesGlobIdentifier,
  risksTouchedBy,
  serializeSlice,
  type IndexedRiskCatalog,
} from '@vaubaan/policy-engine';
import {
  isExplicitRiskId,
  type McpToolResult,
  type Resource,
  type RiskCatalog,
  type RiskId,
  type Slice,
} from '@vaubaan/shared';

import { fallbackFlagIssues, wildcardIssues } from '../catalog-rules.ts';
import { declaredToolNames, pluginIssues } from '../define-plugin.ts';
import type { ProviderPlugin } from '../plugin.ts';
import { PluginRegistry } from '../registry.ts';
import type { SampleCall, ToolSamples } from '../samples.ts';
import { sliceRoundTripIssues } from '../slices.ts';

export class PluginAssertionError extends Error {
  constructor(
    readonly subject: string,
    readonly findings: readonly string[],
  ) {
    super(`${subject}:\n  - ${findings.join('\n  - ')}`);
    this.name = 'PluginAssertionError';
  }
}

function fail(subject: string, findings: readonly string[]): void {
  if (findings.length > 0) throw new PluginAssertionError(subject, findings);
}

/**
 * `definePlugin`'s checks, as an assertion (useful on a plugin built without
 * it), plus the one rule the loader only warns about : the fallback entry
 * must carry `fallback: true` (a plugin tested with the kit is first-party
 * enough to be held to it).
 */
export function assertPluginWellFormed(plugin: ProviderPlugin): void {
  fail(`plugin '${String(plugin.id)}' is not well-formed`, [
    ...pluginIssues(plugin),
    ...(plugin.catalog && typeof plugin.catalog === 'object'
      ? fallbackFlagIssues(plugin.catalog).map((m) => `catalog: ${m}`)
      : []),
  ]);
}

/**
 * No risk id, restriction or accepted-risk list may contain a
 * wildcard or a sentinel. Accepts a catalog, a plugin, or a plain list of
 * ids (a persisted restriction, a mission's `accepted_risks`).
 */
export function assertNoWildcard(input: RiskCatalog | ProviderPlugin | readonly RiskId[]): void {
  if (isIdList(input)) {
    const ids: readonly RiskId[] = input;
    fail(
      'wildcard or sentinel in RiskId list',
      ids.filter((id) => !isExplicitRiskId(id)).map((id) => `'${id}' is not an explicit RiskId`),
    );
    return;
  }
  const catalog = 'catalog' in input ? input.catalog : input;
  fail(`wildcard in catalog '${catalog.provider}'`, wildcardIssues(catalog));
}

/** `Array.isArray` narrows a readonly array to `any[]` ; this guard keeps the element type. */
function isIdList(x: RiskCatalog | ProviderPlugin | readonly RiskId[]): x is readonly RiskId[] {
  return Array.isArray(x);
}

// The sample types are the contract's (`ProviderPlugin.examples`); re-exported so the kit's
// existing imports keep working.
export type { SampleCall, ToolSamples } from '../samples.ts';

export interface CoverageOptions {
  /** Resources used by samples that declare none. */
  readonly resources?: readonly Resource[];
}

export interface CoverageReport {
  readonly toolsChecked: number;
  readonly samplesChecked: number;
  /** Distinct catalog risks touched across all samples, in catalog order. */
  readonly risksTouched: readonly RiskId[];
  /**
   * Catalog risks no sample touched, the fallback excluded — informational,
   * not a failure. The fallback is reachable by design only through writes
   * no dedicated entry covers (ADR fallback-risk-only-when-uncategorized),
   * so a complete catalog never touches it ; it is never "untouched" in the
   * sense this list carries. `fallbackHits` tells whether it fired.
   */
  readonly risksUntouched: readonly RiskId[];
  /**
   * Samples whose slice touched the fallback — that is, a write no
   * dedicated entry covers (ADR fallback-risk-only-when-uncategorized).
   * Informational : a realistic sample landing here usually means the
   * catalog misses an entry.
   */
  readonly fallbackHits: readonly string[];
}

/**
 * Every tool yields at least one slice, and every emitted slice is matched
 * by at least one risk of the plugin's own catalog, reads back as itself
 * through serialise → parse, and carries no glob inside an identifier. A tool that classifies
 * to nothing, or a slice no risk covers, would be refused at runtime for
 * the wrong reason — or worse, slip through a future lenient path. The
 * plugin declares realistic arguments per tool (`examples`, the default) or
 * the test passes its own ; the kit checks the plumbing.
 */
export function assertCatalogCoverage(
  plugin: ProviderPlugin,
  samples: ToolSamples | undefined = plugin.examples,
  options: CoverageOptions = {},
): CoverageReport {
  if (samples === undefined) {
    throw new PluginAssertionError(`catalog coverage of plugin '${plugin.id}'`, [
      'no samples: declare `examples` on the plugin or pass them',
    ]);
  }
  const registry = new PluginRegistry([plugin]);
  const indexed: IndexedRiskCatalog = registry.catalogOf(plugin.id);
  // The MCP tools and, for a plugin with a git remote, its two tools.
  const declared = declaredToolNames(plugin);
  const run: CoverageRun = {
    plugin,
    indexed,
    fallbackIds: new Set(indexed.entries.filter((e) => e.fallback).map((e) => e.entry.id)),
    defaultResources: options.resources ?? [],
    findings: sampleSetFindings(declared, samples),
    touched: new Set<RiskId>(),
    fallbackHits: [],
  };

  let samplesChecked = 0;
  for (const [tool, calls] of Object.entries(samples)) {
    if (!declared.has(tool)) continue;
    calls.forEach((sample, i) => {
      samplesChecked += 1;
      classifySample(run, sample, `'${tool}' sample #${i + 1}`, tool);
    });
  }

  fail(`catalog coverage of plugin '${plugin.id}'`, run.findings);
  const all = plugin.catalog.risks.map((r) => r.id);
  return {
    toolsChecked: declared.size,
    samplesChecked,
    risksTouched: all.filter((id) => run.touched.has(id)),
    risksUntouched: all.filter((id) => !run.touched.has(id) && !run.fallbackIds.has(id)),
    fallbackHits: run.fallbackHits,
  };
}

/** What one coverage run reads and accumulates. */
interface CoverageRun {
  readonly plugin: ProviderPlugin;
  readonly indexed: IndexedRiskCatalog;
  readonly fallbackIds: ReadonlySet<RiskId>;
  readonly defaultResources: readonly Resource[];
  readonly findings: string[];
  readonly touched: Set<RiskId>;
  readonly fallbackHits: string[];
}

/** Every declared tool has a sample ; every sample names a declared tool. */
function sampleSetFindings(declared: ReadonlySet<string>, samples: ToolSamples): string[] {
  const findings: string[] = [];
  for (const tool of declared) {
    if (!samples[tool] || samples[tool].length === 0)
      findings.push(`tool '${tool}' has no sample call`);
  }
  for (const tool of Object.keys(samples)) {
    if (!declared.has(tool))
      findings.push(`sample for '${tool}' but the plugin declares no such tool`);
  }
  return findings;
}

/** Classify one sample and check the outcome against what the sample expects. */
function classifySample(run: CoverageRun, sample: SampleCall, where: string, tool: string): void {
  const resources = sample.resources ?? run.defaultResources;
  const outcome = run.plugin.classify(tool, sample.args, resources);
  if ('denied' in outcome) {
    if (!sample.expectDenied)
      run.findings.push(
        `${where}: classifier denied (${outcome.denied}) but the sample did not expect it`,
      );
    return;
  }
  if (sample.expectDenied) {
    run.findings.push(
      `${where}: expected the classifier to deny, got ${outcome.slices.length} slice(s)`,
    );
    return;
  }
  if (outcome.slices.length === 0) {
    run.findings.push(`${where}: classifier returned no slice`);
    return;
  }
  outcome.slices.forEach((slice, s) => sliceFindings(run, slice, `${where} slice #${s + 1}`));
}

/** One emitted slice : the plugin's own provider, and at least one catalog risk. */
function sliceFindings(run: CoverageRun, slice: Slice, where: string): void {
  if (slice.provider !== run.plugin.id) {
    run.findings.push(`${where}: provider '${slice.provider}' is not '${run.plugin.id}'`);
    return;
  }
  // What is decided on is also written (audit, refusal, session) : it must read back as
  // itself, and name what the call touches rather than a pattern of it.
  for (const issue of sliceRoundTripIssues(slice)) run.findings.push(`${where}: ${issue}`);
  if (carriesGlobIdentifier(slice)) {
    run.findings.push(
      `${where}: '${serializeSlice(slice)}' carries '*' inside an identifier (the host refuses it)`,
    );
  }
  const risks = risksTouchedBy(slice, run.indexed);
  if (risks.length === 0) run.findings.push(`${where}: no catalog risk matches it`);
  if (risks.some((r) => run.fallbackIds.has(r))) run.fallbackHits.push(where);
  for (const r of risks) run.touched.add(r);
}

/**
 * The entries of `args` that `tool` declares in its input schema. For test
 * tables that feed one argument object to a whole family of tools : an
 * argument a tool does not declare is refused by its classifier
 * (`undeclaredArgumentDenial`), which would hide the rule the table is about.
 */
export function declaredOnly(
  plugin: Pick<ProviderPlugin, 'tools'>,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const declaration = plugin.tools.find((t) => t.name === tool);
  if (!declaration) throw new Error(`declaredOnly: '${tool}' is not a tool of this plugin`);
  const names = new Set(Object.keys(declaration.inputSchema.properties ?? {}));
  return Object.fromEntries(Object.entries(args).filter(([key]) => names.has(key)));
}

/**
 * The reason of a call the executor declined : awaits `execute`, requires an
 * `isError` result (a throw would be a provider failure, and fails the test as
 * one) and returns its text.
 */
export async function refusalText(run: Promise<McpToolResult>): Promise<string> {
  const result = await run;
  if (result.isError !== true) {
    throw new PluginAssertionError('expected the executor to decline the call', [
      `got a result without isError: ${JSON.stringify(result.content).slice(0, 200)}`,
    ]);
  }
  const [first] = result.content;
  return first?.type === 'text' ? first.text : '';
}
