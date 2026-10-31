/**
 * Structural test (risk-model spec §2, §3 ; ADR
 * plugin-contract-and-credential-spec, amendment of 2026-10-31): every live
 * pattern of every shipped catalog walks the plugin's own data model
 * (`catalogPathIssues`). A pattern off the model matches nothing, silently.
 *
 * No shipped catalog has a gap any more (GitHub's `search.*` patterns walk
 * the `search` plane it now declares). The check is meant to move into
 * `definePlugin`; one test fixture of the gateway (`depot`, in
 * `src/server/execution/testing.ts`) still names an `account` entity its
 * model does not declare, so it is held here until that fixture is fixed.
 */
import { catalogPathIssues } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';

describe('shipped catalogs name only paths of their data model', () => {
  it.each(SHIPPED_PLUGINS.map((plugin) => [plugin.id, plugin] as const))(
    '%s: every live pattern walks its data model',
    (_id, plugin) => {
      expect(catalogPathIssues(plugin)).toEqual([]);
    },
  );
});
