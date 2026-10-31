/**
 * `assertSlicesOnDataModel` — what the classifier emits is a path of the
 * plugin's own data model (risk-model spec §2, §3 ; `data-model-paths.ts`).
 * A slice off the model is accepted by the engine and falls to the fallback,
 * or to nothing : the data model would no longer be what a reviewer compares
 * the classifier with.
 */

import { serializeSlice } from '@vaubaan/policy-engine';
import type { Resource } from '@vaubaan/shared';

import { slicePathIssue } from '../data-model-paths.ts';
import type { ProviderPlugin } from '../plugin.ts';
import { PluginAssertionError, type ToolSamples } from './assertions.ts';

export interface SlicesOnDataModelOptions {
  /** Resources used by samples that declare none. */
  readonly resources?: readonly Resource[];
  /**
   * Hold each identifier to the entity's declared cardinalities (`[x]` or
   * none `one`, `[a,b]` `bounded`, `[*]` `unbounded`). Default true.
   */
  readonly cardinalities?: boolean;
}

/**
 * Classify every sample (the table `assertCatalogCoverage` takes) and walk
 * each slice on `plugin.dataModel` : rooted at a declared entity, each name
 * a child of the one before, a virtual leaf last only, cardinalities
 * included unless turned off. Samples the classifier denies are skipped.
 * Throws `PluginAssertionError` listing every slice off the model.
 */
export function assertSlicesOnDataModel(
  plugin: ProviderPlugin,
  samples: ToolSamples,
  options: SlicesOnDataModelOptions = {},
): void {
  const findings: string[] = [];
  for (const [tool, calls] of Object.entries(samples)) {
    calls.forEach((sample, i) => {
      const outcome = plugin.classify(
        tool,
        sample.args,
        sample.resources ?? options.resources ?? [],
      );
      if ('denied' in outcome) return;
      for (const slice of outcome.slices) {
        const issue = slicePathIssue(plugin.dataModel, slice, 'slice', {
          cardinalities: options.cardinalities ?? true,
        });
        if (issue)
          findings.push(`'${tool}' sample #${i + 1}: '${serializeSlice(slice)}': ${issue}`);
      }
    });
  }
  if (findings.length > 0) {
    throw new PluginAssertionError(`slices of plugin '${plugin.id}' off its data model`, findings);
  }
}
