/**
 * Structural assertions every plugin test suite runs.
 *
 * Spec : docs/spec/vaubaan-gateway.md §10 — each plugin's classifier is
 * unit-tested ("a classification error is a security hole") ; every plugin
 * ships at least one preset referencing only its own risks ; no wildcard
 * anywhere. Framework-agnostic : each assertion throws a plain
 * `PluginAssertionError` listing every finding, so it works under vitest,
 * node:test or a CI script.
 */

import { risksTouchedBy, type IndexedRiskCatalog } from '@vaubaan/policy-engine';
import { isExplicitRiskId, type Resource, type RiskCatalog, type RiskId } from '@vaubaan/shared';

import { presetIssues, wildcardIssues } from '../catalog-loader.ts';
import { pluginIssues } from '../define-plugin.ts';
import type { ProviderPlugin } from '../plugin.ts';
import { PluginRegistry } from '../registry.ts';

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

/** `definePlugin`'s checks, as an assertion (useful on a plugin built without it). */
export function assertPluginWellFormed(plugin: ProviderPlugin): void {
  fail(`plugin '${String(plugin.id)}' is not well-formed`, pluginIssues(plugin));
}

/**
 * No risk id, preset entry, restriction or accepted-risk list may contain a
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

/** At least one preset ; every entry a risk of the same catalog ; budgets explicit. */
export function assertPresetsValid(input: RiskCatalog | ProviderPlugin): void {
  const catalog = 'catalog' in input ? input.catalog : input;
  fail(`presets of catalog '${catalog.provider}'`, [
    ...presetIssues(catalog, { requirePresets: true }),
    ...wildcardIssues(catalog).filter((m) => m.startsWith('presets')),
  ]);
}

/** One representative call of a tool. */
export interface SampleCall {
  readonly args: Readonly<Record<string, unknown>>;
  /** Mission resources for this sample ; defaults to `options.resources`. */
  readonly resources?: readonly Resource[];
  /** Set when the classifier itself is expected to refuse this sample. */
  readonly expectDenied?: boolean;
}

/** Sample calls keyed by tool name. Every tool of the plugin needs at least one. */
export type ToolSamples = Readonly<Record<string, readonly SampleCall[]>>;

export interface CoverageOptions {
  /** Resources used by samples that declare none. */
  readonly resources?: readonly Resource[];
}

export interface CoverageReport {
  readonly toolsChecked: number;
  readonly samplesChecked: number;
  /** Distinct catalog risks touched across all samples, in catalog order. */
  readonly risksTouched: readonly RiskId[];
  /** Catalog risks no sample touched — informational, not a failure (the fallback often stays untouched). */
  readonly risksUntouched: readonly RiskId[];
}

/**
 * Every tool yields at least one slice, and every emitted slice is matched
 * by at least one risk of the plugin's own catalog. A tool that classifies
 * to nothing, or a slice no risk covers, would be refused at runtime for
 * the wrong reason — or worse, slip through a future lenient path. The
 * test author supplies realistic arguments per tool ; the kit checks the
 * plumbing.
 */
export function assertCatalogCoverage(
  plugin: ProviderPlugin,
  samples: ToolSamples,
  options: CoverageOptions = {},
): CoverageReport {
  const findings: string[] = [];
  const registry = new PluginRegistry([plugin]);
  const indexed: IndexedRiskCatalog = registry.catalogOf(plugin.id);
  const declared = new Set(plugin.tools.map((t) => t.name));

  for (const tool of declared) {
    if (!samples[tool] || samples[tool].length === 0)
      findings.push(`tool '${tool}' has no sample call`);
  }
  for (const tool of Object.keys(samples)) {
    if (!declared.has(tool))
      findings.push(`sample for '${tool}' but the plugin declares no such tool`);
  }

  const touched = new Set<RiskId>();
  let samplesChecked = 0;
  for (const [tool, calls] of Object.entries(samples)) {
    if (!declared.has(tool)) continue;
    calls.forEach((sample, i) => {
      samplesChecked += 1;
      const where = `'${tool}' sample #${i + 1}`;
      const resources = sample.resources ?? options.resources ?? [];
      const outcome = plugin.classify(tool, sample.args, resources);
      if ('denied' in outcome) {
        if (!sample.expectDenied)
          findings.push(
            `${where}: classifier denied (${outcome.denied}) but the sample did not expect it`,
          );
        return;
      }
      if (sample.expectDenied) {
        findings.push(
          `${where}: expected the classifier to deny, got ${outcome.slices.length} slice(s)`,
        );
        return;
      }
      if (outcome.slices.length === 0) {
        findings.push(`${where}: classifier returned no slice`);
        return;
      }
      outcome.slices.forEach((slice, s) => {
        if (slice.provider !== plugin.id) {
          findings.push(
            `${where} slice #${s + 1}: provider '${slice.provider}' is not '${plugin.id}'`,
          );
          return;
        }
        const risks = risksTouchedBy(slice, indexed);
        if (risks.length === 0)
          findings.push(`${where} slice #${s + 1}: no catalog risk matches it`);
        for (const r of risks) touched.add(r);
      });
    });
  }

  fail(`catalog coverage of plugin '${plugin.id}'`, findings);
  const all = plugin.catalog.risks.map((r) => r.id);
  return {
    toolsChecked: declared.size,
    samplesChecked,
    risksTouched: all.filter((id) => touched.has(id)),
    risksUntouched: all.filter((id) => !touched.has(id)),
  };
}
