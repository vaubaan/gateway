/**
 * Structural test (ADR plugin-contract-and-credential-spec, amendment
 * 2026-11-05): every plugin the image ships declares its tool samples as
 * `examples`, one sample at least per tool, each naming the mission resources
 * it runs on — the samples its tests run through the kit and the site
 * classifies when it builds, without the plugin's test fixtures.
 *
 * Read from the plugins the image ships (`compose/shipped-plugins.ts`).
 * `definePlugin` already refuses malformed samples; each plugin's own tests
 * run them through `assertCatalogCoverage`. This holds the shipped plugins to
 * *having* them.
 */
import { declaredToolNames } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

describe('every shipped plugin declares examples', () => {
  describe.each(REPOSITORY_PLUGINS.map((plugin) => [plugin.id, plugin] as const))(
    '%s',
    (_id, plugin) => {
      it('has a sample for each of its tools', () => {
        expect(plugin.examples).toBeDefined();
        const examples = plugin.examples ?? {};
        const missing = [...declaredToolNames(plugin)].filter(
          (tool) => (examples[tool]?.length ?? 0) === 0,
        );
        expect(missing).toEqual([]);
      });

      it('names the resources of every sample, so the site classifies it as the tests do', () => {
        const without = Object.entries(plugin.examples ?? {}).flatMap(([tool, calls]) =>
          calls.flatMap((call, i) => (call.resources === undefined ? [`${tool} #${i + 1}`] : [])),
        );
        expect(without).toEqual([]);
      });
    },
  );
});
