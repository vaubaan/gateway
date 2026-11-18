/**
 * Structural test (spec §10): "every catalog groups each of its risks but the
 * fallback in exactly one macro-action, and no catalog ships presets" — and
 * no macro-action takes a name the gateway keeps for itself (ADR
 * macro-actions-and-trust-levels-prefill-the-policy).
 *
 * Read from the plugins the image ships (`compose/shipped-plugins.ts`), not
 * from a list kept here: a plugin added tomorrow is held to the rule the day
 * it enters the import list. Each plugin's own unit tests check its catalog in
 * detail (`assertPluginWellFormed` of the plugin SDK); this is the rule seen
 * from the application, on exactly what it loads. The catalog sources are read
 * too, so a `presets` key the loader would drop silently still fails here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANYTHING_ELSE_MACRO_ACTION, isFallbackEntry } from '@vaubaan/policy-engine';
import { parseRiskId } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';
import { EVERYTHING_I_HOLD } from '../../../src/lib/missions/everything-i-hold';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS = resolve(HERE, '../../../../../plugins');
const WILDCARD = /[*?]|\ball\b/i;
/** The ids the gateway gives its own groups: no catalog may declare them. */
const RESERVED = [ANYTHING_ELSE_MACRO_ACTION, EVERYTHING_I_HOLD];

/** Every YAML file under `plugins/<id>/src`, the template included. */
function catalogSources(): string[] {
  return readdirSync(PLUGINS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PLUGINS, entry.name, 'src'))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => join(dir, name)),
    );
}

describe('every shipped catalog groups its risks in macro-actions, and ships no presets', () => {
  it('the image ships plugins at all', () => {
    expect(REPOSITORY_PLUGINS.length).toBeGreaterThan(0);
  });

  it('no catalog source declares presets', () => {
    const sources = catalogSources();
    expect(sources.length).toBeGreaterThanOrEqual(REPOSITORY_PLUGINS.length);
    const withPresets = sources.filter((path) => /^presets\s*:/m.test(readFileSync(path, 'utf8')));
    expect(withPresets).toEqual([]);
  });

  describe.each(REPOSITORY_PLUGINS.map((plugin) => [plugin.id, plugin] as const))(
    '%s',
    (id, plugin) => {
      const actions = plugin.catalog.macro_actions ?? [];

      it('ships no presets key', () => {
        expect(Object.keys(plugin.catalog)).not.toContain('presets');
      });

      it('ships at least one macro-action, each with at least one entry', () => {
        expect(actions.length).toBeGreaterThan(0);
        for (const action of actions) {
          expect(action.entries.length, action.id).toBeGreaterThan(0);
        }
      });

      it('puts each live risk but the fallback in exactly one macro-action', () => {
        const count = new Map<string, number>();
        for (const action of actions) {
          for (const entry of action.entries) {
            count.set(entry.risk_id, (count.get(entry.risk_id) ?? 0) + 1);
          }
        }
        const live = plugin.catalog.risks.filter((risk) => !risk.deprecated);
        const grouped = live.filter((risk) => !isFallbackEntry(risk, plugin.id));
        const misgrouped = grouped
          .filter((risk) => count.get(risk.id) !== 1)
          .map((risk) => `${risk.id}: ${count.get(risk.id) ?? 0}`);
        expect(misgrouped).toEqual([]);
        // The fallback is the gateway's "Anything else", never a catalog's own.
        const fallbacks = live.filter((risk) => isFallbackEntry(risk, plugin.id));
        for (const risk of fallbacks) expect(count.get(risk.id), risk.id).toBeUndefined();
      });

      it('names only explicit risks of its own catalog, never a wildcard', () => {
        const own = new Set(plugin.catalog.risks.map((risk) => risk.id));
        const foreign = actions.flatMap((action) =>
          action.entries
            .filter((entry) => !own.has(entry.risk_id))
            .map((entry) => `${action.id}: ${entry.risk_id}`),
        );
        expect(foreign).toEqual([]);
        for (const action of actions) {
          expect(action.id, action.id).not.toMatch(/[*?]/);
          for (const entry of action.entries) {
            expect(entry.risk_id, `${action.id}: ${entry.risk_id}`).not.toMatch(WILDCARD);
            expect(parseRiskId(entry.risk_id)?.service, entry.risk_id).toBe(id);
          }
        }
      });

      it('leaves "anything-else" and "everything-i-hold" to the gateway, and names each macro-action once', () => {
        const ids = actions.map((action) => action.id);
        for (const reserved of RESERVED) expect(ids).not.toContain(reserved);
        expect(new Set(ids).size).toBe(ids.length);
      });
    },
  );
});
