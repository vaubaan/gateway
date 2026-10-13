/**
 * Structural test (spec §10): "every plugin ships at least one preset, and
 * every preset references only `RiskId`s of its own catalog" — and no preset
 * says "everything" (spec §3.1 "Enumeration").
 *
 * Read from the plugins the image ships (`compose/shipped-plugins.ts`), not
 * from a list kept here: a plugin added tomorrow is held to the rule the day
 * it enters the import list. Each plugin's own unit tests check its catalog in
 * detail (`assertPluginWellFormed` of the plugin SDK); this is the rule seen
 * from the application, on exactly what it loads.
 */
import { parseRiskId } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { fullCatalogRiskIds } from '../../../src/server/authority';
import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';

const WILDCARD = /[*?]|\ball\b/i;

describe('every shipped plugin ships presets made of its own explicit risks', () => {
  it('the image ships plugins at all', () => {
    expect(SHIPPED_PLUGINS.length).toBeGreaterThan(0);
  });

  describe.each(SHIPPED_PLUGINS.map((plugin) => [plugin.id, plugin] as const))(
    '%s',
    (id, plugin) => {
      const presets = plugin.catalog.presets ?? [];
      // An entry names an explicit id, or the base id of an environment-scoped risk
      // (`stripe.read-catalog`): issuance resolves that one to the environment of the
      // selected resources, and what is persisted is the explicit id it resolved to.
      const own = new Set<string>([
        ...fullCatalogRiskIds(plugin.catalog),
        ...plugin.catalog.risks.map((risk) => risk.id),
      ]);

      it('ships at least one preset, each with at least one entry', () => {
        expect(presets.length).toBeGreaterThan(0);
        for (const preset of presets) {
          expect(preset.entries.length, preset.id).toBeGreaterThan(0);
        }
      });

      it('references only risks of its own catalog', () => {
        const foreign = presets.flatMap((preset) =>
          preset.entries
            .filter((entry) => !own.has(entry.risk_id))
            .map((entry) => `${preset.id}: ${entry.risk_id}`),
        );
        expect(foreign).toEqual([]);
        for (const preset of presets) {
          for (const entry of preset.entries) {
            expect(parseRiskId(entry.risk_id)?.provider, entry.risk_id).toBe(id);
          }
        }
      });

      it('never says "everything": no wildcard in a preset id or in an entry', () => {
        for (const preset of presets) {
          expect(preset.id, preset.id).not.toMatch(/[*?]/);
          for (const entry of preset.entries) {
            expect(entry.risk_id, `${preset.id}: ${entry.risk_id}`).not.toMatch(WILDCARD);
          }
        }
      });

      it('names each preset once', () => {
        const ids = presets.map((preset) => preset.id);
        expect(new Set(ids).size).toBe(ids.length);
      });
    },
  );
});
