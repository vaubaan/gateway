/**
 * Structural test (risk-model spec §2, §3 ; ADR
 * plugin-contract-and-credential-spec, amendment of 2026-10-31): every live
 * pattern of every shipped catalog walks the plugin's own data model
 * (`catalogPathIssues`). A pattern off the model matches nothing, silently.
 *
 * The gaps found when the check was written are pinned below, exactly: they
 * are modelling decisions for their plugin, not typos. A new gap fails, and
 * so does a pinned one that was closed, so the table only shrinks; once it is
 * empty, the check moves into `definePlugin`.
 */
import { catalogPathIssues } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';

/** Plugin id → the issues its catalog has today. */
const KNOWN_GAPS: Readonly<Record<string, readonly string[]>> = {
  // The two search tools emit `github.search.code.R` / `github.search.issues.R`;
  // the data model declares no `search` entity.
  github: [
    "risks[2] 'github.search-global' matches 'github.search.code.R': 'search' is not an entity of the data model",
    "risks[2] 'github.search-global' matches 'github.search.issues.R': 'search' is not an entity of the data model",
  ],
};

describe('shipped catalogs name only paths of their data model', () => {
  it.each(SHIPPED_PLUGINS.map((plugin) => [plugin.id, plugin] as const))(
    '%s: every live pattern walks its data model, known gaps aside',
    (id, plugin) => {
      expect(catalogPathIssues(plugin)).toEqual(KNOWN_GAPS[id] ?? []);
    },
  );

  it('every plugin with a known gap is shipped', () => {
    const shipped = new Set(SHIPPED_PLUGINS.map((plugin) => plugin.id));
    expect(Object.keys(KNOWN_GAPS).filter((id) => !shipped.has(id))).toEqual([]);
  });
});
