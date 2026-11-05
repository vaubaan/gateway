/**
 * Structural test (ADR plugin-contract-and-credential-spec, amendment
 * 2026-11-05): a tool the risk model leaves out on purpose (spec
 * gateway-risk-model §7.2) is named in the plugin's `excludedTools`, and every
 * excluded tool of a shipped plugin is refused by its classifier by name.
 *
 * `definePlugin` already refuses an excluded name that is a declared tool.
 */
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';

/** The tools spec §7.2 names, per provider. */
const LEFT_OUT_BY_THE_RISK_MODEL: Readonly<Record<string, readonly string[]>> = {
  github: [
    'github__dispatch_workflow',
    'github__cancel_workflow_run',
    'github__rerun_workflow_run',
  ],
};

describe('tools left out on purpose', () => {
  it.each(Object.entries(LEFT_OUT_BY_THE_RISK_MODEL))(
    '%s declares the tools spec §7.2 leaves out',
    (id, tools) => {
      const plugin = SHIPPED_PLUGINS.find((p) => p.id === id);
      expect(Object.keys(plugin?.excludedTools ?? {})).toEqual(expect.arrayContaining([...tools]));
    },
  );

  describe.each(
    SHIPPED_PLUGINS.filter((plugin) => plugin.excludedTools !== undefined).map(
      (plugin) => [plugin.id, plugin] as const,
    ),
  )('%s', (_id, plugin) => {
    it('refuses every excluded tool by name', () => {
      const accepted = Object.keys(plugin.excludedTools ?? {}).filter(
        (tool) => !('denied' in plugin.classify(tool, {}, [])),
      );
      expect(accepted).toEqual([]);
    });
  });
});
