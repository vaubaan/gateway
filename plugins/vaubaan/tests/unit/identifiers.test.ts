/**
 * Hostile identifiers through the `vaubaan` plugin (ADR
 * plugin-identifiers-one-grammar-for-classify-and-execute): what is executed is
 * what was classified. The plugin builds no URL — its `execute` is the host's,
 * handed the arguments as they came — so an id lands in a slice, never in a
 * request path; the host reads every argument again with its own schemas.
 *
 * The plugin's declared `execute` refuses every call, so the proof runs the
 * plugin as the host composes it: `createVaubaanExecute` over ports that record
 * what they were handed.
 */
import { describe, expect, it } from 'vitest';

import { serializeSlice, type ExecuteContext, type ProviderPlugin } from '@vaubaan/plugin-sdk';
import { assertIdentifiersRefused } from '@vaubaan/plugin-sdk/testing';

import {
  classifyVaubaan,
  createVaubaanExecute,
  TOOL,
  vaubaanPlugin,
  type VaubaanExecuteContext,
  type VaubaanPorts,
} from '../../src/index.ts';

const CALLER = { missionId: 'mission-caller', userId: 'user-ada', holderUserId: 'user-ada' };

/** Ports that answer yes and remember the arguments of every act. */
function recordingPorts(seen: unknown[]): VaubaanPorts {
  return Object.fromEntries(
    Object.keys(TOOL).map((act) => [
      act,
      async (_caller: unknown, args: unknown) => {
        seen.push(args);
        return { ok: true, data: {} } as const;
      },
    ]),
  ) as unknown as VaubaanPorts;
}

/** The plugin as the host runs it: the caller added to the SDK's context. */
function asComposedByTheHost(seen: unknown[]): ProviderPlugin {
  const execute = createVaubaanExecute(recordingPorts(seen));
  return {
    ...vaubaanPlugin,
    execute: (ctx: ExecuteContext, tool: string, args: Readonly<Record<string, unknown>>) =>
      execute({ ...ctx, caller: CALLER }, tool, args),
  };
}

describe('vaubaan — hostile identifiers', () => {
  it('runs the SDK kit: nothing leaves the process, whatever the identifier', async () => {
    const seen: unknown[] = [];
    const report = await assertIdentifiersRefused(
      asComposedByTheHost(seen),
      vaubaanPlugin.examples,
      {
        context: (fetch, resources) =>
          ({
            fetch,
            resources,
            credential: { kind: 'host', metadata: {} },
          }) as unknown as ExecuteContext,
        pathIdentifiers: {
          none: 'no request at all: the host reads the arguments with its own schemas, in process',
        },
      },
    );
    expect(report.toolsChecked).toBe(vaubaanPlugin.tools.length);
  });

  it.each(['..', '%2e%2e', '../other', 'a/../b'])(
    'a mission id %s is one opaque segment for classify, and reaches the host as sent',
    async (hostile) => {
      const outcome = classifyVaubaan(TOOL.revokeMission, { mission_id: hostile });
      if ('denied' in outcome) return;
      const [slice] = outcome.slices.map(serializeSlice);
      // One segment, never a path the grammar would read as another plane.
      expect(slice).toMatch(/^vaubaan\.mission\[.*\]\.revoke\.W$/);
      const seen: unknown[] = [];
      await createVaubaanExecute(recordingPorts(seen))(
        { caller: CALLER } as unknown as VaubaanExecuteContext,
        TOOL.revokeMission,
        { mission_id: hostile },
      );
      expect(seen).toEqual([{ mission_id: hostile }]);
    },
  );
});
