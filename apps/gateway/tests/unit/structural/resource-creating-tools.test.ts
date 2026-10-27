/**
 * Structural test (ADR created-resources-join-the-mission): the tools of the
 * shipped plugins whose success creates a resource of the connection — the
 * calls after which the execution door runs the connection's discovery again,
 * and whose answer the plugin reads (`createdResources`) so the mission that
 * made the call reaches what it created (ADR created-resources-join-the-mission).
 *
 * Read from the plugins the image ships (`compose/shipped-plugins.ts`). The
 * expected table is kept here on purpose: adding or dropping a creating tool
 * changes what the gateway does after a call (a discovery at the provider),
 * so it is a reviewed change of this file, not a side effect. `definePlugin`
 * already refuses a name that is not a tool of the plugin; this pins which
 * plugins declare what.
 */
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';

/** Plugin id → the tools whose success creates something its discovery lists. */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  fly: ['fly__create_app'],
  miro: ['miro__board_create'],
  railway: ['railway__create-project'],
  resend: ['resend__create_domain', 'resend__create_segment'],
  'upstash-redis': ['upstash_redis__create_database'],
};

describe('resource-creating tools of the shipped plugins', () => {
  it.each(SHIPPED_PLUGINS.map((plugin) => [plugin.id, plugin] as const))(
    '%s declares exactly its creating tools, each one of its MCP tools',
    (id, plugin) => {
      const declared = plugin.resourceCreatingTools ?? [];
      expect([...declared].sort()).toEqual([...(EXPECTED[id] ?? [])].sort());
      const tools = new Set(plugin.tools.map((t) => t.name));
      for (const tool of declared) expect(tools.has(tool), tool).toBe(true);
    },
  );

  it.each(
    SHIPPED_PLUGINS.filter((plugin) => plugin.resourceCreatingTools).map((p) => [p.id, p] as const),
  )('%s reads what its creating tools created (createdResources)', (_id, plugin) => {
    // ADR created-resources-join-the-mission: the mission that created it reaches it.
    expect(typeof plugin.createdResources).toBe('function');
    // An answer it cannot read gives nothing, for every creating tool.
    for (const tool of plugin.resourceCreatingTools ?? []) {
      expect(plugin.createdResources?.(tool, {}, { content: [] })).toEqual([]);
      expect(
        plugin.createdResources?.(tool, {}, { content: [{ type: 'text', text: 'created' }] }),
      ).toEqual([]);
    }
  });

  it('every plugin named in the table is shipped', () => {
    const shipped = new Set(SHIPPED_PLUGINS.map((plugin) => plugin.id));
    for (const id of Object.keys(EXPECTED)) expect(shipped.has(id), id).toBe(true);
  });
});
