/**
 * `assertIdentifiersRefused` — the kit's behavioural proof that what a plugin
 * executes is what it classified (ADR
 * plugin-identifiers-one-grammar-for-classify-and-execute).
 *
 * The fixture plugin `acme` is written the way the defect was : it puts its
 * arguments in the request path as they come. The kit must find it, and must
 * pass the same plugin once one grammar guards `classify` and `execute`.
 */

import { parseSlice } from '@vaubaan/policy-engine';
import { describe, expect, test } from 'vitest';

import type { ClassifyOutcome, ExecuteContext, ServicePlugin } from '../../src/index.ts';
import {
  assertIdentifiersRefused,
  HOSTILE_IDENTIFIERS,
  PluginAssertionError,
  type MockFetch,
  type ToolSamples,
} from '../../src/testing/index.ts';
import { ACME_API, acmePlugin } from '../fixtures/acme/acme-plugin.ts';

const SAMPLES: ToolSamples = {
  acme__list_things: [{ args: { space: 'sp-1' } }],
  acme__update_thing: [{ args: { space: 'sp-1', thing_id: 't-9', name: 'New name' } }],
};

const context = (fetch: MockFetch): ExecuteContext => ({
  credential: { kind: 'api-key', fields: { api_key: 'k' }, metadata: {} },
  fetch,
  resources: [],
});

const ident = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;

type Execute = ServicePlugin['execute'];

/** `acme` with one grammar for its two identifiers, in `classify` and wherever `guard` says. */
function acmeWith(parts: {
  readonly classify?: ServicePlugin['classify'];
  readonly execute?: Execute;
}): ServicePlugin {
  return { ...acmePlugin, ...parts };
}

const guardedClassify: ServicePlugin['classify'] = (tool, args): ClassifyOutcome => {
  const space = ident(args.space);
  if (space === null) return { denied: 'space: malformed' };
  if (tool === 'acme__list_things') {
    return { slices: [parseSlice(`acme.space[${space}].thing[*].R`)] };
  }
  const thing = ident(args.thing_id);
  if (thing === null) return { denied: 'thing_id: malformed' };
  return { slices: [parseSlice(`acme.space[${space}].thing[${thing}].W`)] };
};

const send = async (ctx: ExecuteContext, method: string, path: string, body?: unknown) => {
  await ctx.fetch(`${ACME_API}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { content: [{ type: 'text' as const, text: 'ok' }] };
};

const declined = { content: [{ type: 'text' as const, text: 'malformed' }], isError: true };

const guardedExecute: Execute = async (ctx, tool, args) => {
  const space = ident(args.space);
  if (space === null) return declined;
  if (tool === 'acme__list_things') return send(ctx, 'GET', `/spaces/${space}/things`);
  const thing = ident(args.thing_id);
  if (thing === null) return declined;
  return send(ctx, 'PATCH', `/spaces/${space}/things/${thing}`, { name: args.name });
};

/** The executor of the defect : the argument goes in the path as it comes. */
const rawExecute: Execute = async (ctx, tool, args) =>
  tool === 'acme__list_things'
    ? send(ctx, 'GET', `/spaces/${String(args.space)}/things`)
    : send(ctx, 'PATCH', `/spaces/${String(args.space)}/things/${String(args.thing_id)}`, {
        name: args.name,
      });

async function findingsOf(plugin: ServicePlugin, options = {}): Promise<readonly string[]> {
  try {
    await assertIdentifiersRefused(plugin, SAMPLES, { context, ...options });
  } catch (err) {
    if (err instanceof PluginAssertionError) return err.findings;
    throw err;
  }
  return [];
}

describe('assertIdentifiersRefused', () => {
  test('passes a plugin whose classify and execute share one grammar, and says what it ran', async () => {
    const plugin = acmeWith({ classify: guardedClassify, execute: guardedExecute });
    const report = await assertIdentifiersRefused(plugin, SAMPLES, { context });
    expect(report.toolsChecked).toBe(2);
    // space (twice), thing_id, name : the name travels in the body and is checked too.
    expect(report.argumentsChecked).toBe(4);
    expect(report.hostileCalls).toBe(4 * HOSTILE_IDENTIFIERS.length);
    // Found by running the samples, not declared : the two arguments that are path segments.
    expect(report.pathIdentifiers).toEqual([
      { tool: 'acme__list_things', argument: 'space' },
      { tool: 'acme__update_thing', argument: 'space' },
      { tool: 'acme__update_thing', argument: 'thing_id' },
    ]);
    // Every hostile identifier was refused on both sides ; a hostile name is free text.
    expect(report.refusedByClassify).toBe(3 * HOSTILE_IDENTIFIERS.length);
    expect(report.nothingSent).toBe(3 * HOSTILE_IDENTIFIERS.length);
  });

  test('finds the fixture plugin, which interpolates what it is given', async () => {
    const findings = await findingsOf(acmePlugin);
    expect(findings.some((f) => f.includes('a request carries a dot segment'))).toBe(true);
    expect(findings.some((f) => f.includes('reaches a request URL verbatim'))).toBe(true);
  });

  test('finds a grammar applied in classify only : refused, yet sent', async () => {
    const findings = await findingsOf(acmeWith({ classify: guardedClassify, execute: rawExecute }));
    expect(findings).toContainEqual(
      expect.stringMatching(
        /^'acme__list_things' sample #1, space = "\.\.": classify refuses it, execute sends 1 request\(s\)/,
      ),
    );
    // One finding at least per hostile value of each of the three identifier positions.
    const refusedYetSent = findings.filter((f) => f.includes('classify refuses it, execute sends'));
    expect(refusedYetSent).toHaveLength(3 * HOSTILE_IDENTIFIERS.length);
  });

  test('finds a dot segment that escaping left in place, and accepts what escaping names exactly', async () => {
    // `encodeURIComponent` turns `a/../b` into one segment, and leaves `..` as it is.
    const escaping: Execute = async (ctx, tool, args) =>
      send(ctx, 'GET', `/spaces/${encodeURIComponent(String(args.space))}/things`);
    const acceptsAll: ServicePlugin['classify'] = () => ({
      slices: [parseSlice('acme.space[*].thing[*].R')],
    });
    const findings = await findingsOf(acmeWith({ classify: acceptsAll, execute: escaping }), {
      exempt: { acme__update_thing: { thing_id: 'not sent by this double', name: 'free text' } },
    });
    const about = (value: string) =>
      findings.filter((f) => f.includes(`space = ${JSON.stringify(value)}`));
    expect(about('..').some((f) => f.includes('dot segment'))).toBe(true);
    expect(about('.').some((f) => f.includes('dot segment'))).toBe(true);
    expect(about('%2e%2e')).toEqual([]);
    expect(about('a/../b')).toEqual([]);
    expect(about('r1?x=1#y')).toEqual([]);
  });

  test('finds an accepted value that the request does not name', async () => {
    // Trims what it does not like : "repair" instead of refusal.
    const repairing: Execute = async (ctx, tool, args) =>
      send(ctx, 'GET', `/spaces/${String(args.space).replace(/[^A-Za-z0-9-]/g, '')}/things`);
    const acceptsAll: ServicePlugin['classify'] = () => ({
      slices: [parseSlice('acme.space[*].thing[*].R')],
    });
    const findings = await findingsOf(acmeWith({ classify: acceptsAll, execute: repairing }), {
      exempt: { acme__update_thing: { thing_id: 'not sent by this double', name: 'free text' } },
    });
    expect(findings).toContainEqual(
      expect.stringContaining('accepted, but the request does not name it exactly'),
    );
  });

  test('a classifier that throws is a finding, not a pass', async () => {
    const throwing: ServicePlugin['classify'] = (tool, args) => {
      if (ident(args.space) === null) throw new Error('boom');
      return guardedClassify(tool, args, []);
    };
    const findings = await findingsOf(acmeWith({ classify: throwing, execute: guardedExecute }));
    expect(findings).toContainEqual(
      expect.stringContaining('classify threw instead of refusing (boom)'),
    );
  });

  test('refuses to pass on nothing : no identifier seen in a path must be stated, with its reason', async () => {
    const silent: Execute = async () => declined;
    const plugin = acmeWith({ classify: guardedClassify, execute: silent });
    expect(await findingsOf(plugin)).toEqual([expect.stringContaining('the proof ran on nothing')]);
    const report = await assertIdentifiersRefused(plugin, SAMPLES, {
      context,
      pathIdentifiers: { none: 'this double sends nothing' },
    });
    expect(report.pathIdentifiers).toEqual([]);
    // Stated wrongly, it is refused as well.
    expect(
      await findingsOf(acmeWith({ classify: guardedClassify, execute: guardedExecute }), {
        pathIdentifiers: { none: 'wrong' },
      }),
    ).toEqual([expect.stringContaining('declared without identifier in a request path')]);
  });

  test('leaves out the samples the classifier refuses, the undeclared tools and the exempt arguments', async () => {
    const plugin = acmeWith({ classify: guardedClassify, execute: guardedExecute });
    const report = await assertIdentifiersRefused(
      plugin,
      {
        ...SAMPLES,
        acme__list_things: [
          { args: { space: 'sp-1' } },
          { args: { space: 'not valid!' }, expectDenied: true },
          { args: { space: 'also not valid!' } },
        ],
        acme__nope: [{ args: { space: 'sp-1' } }],
      },
      { context, exempt: { acme__update_thing: { name: 'free text of the service' } } },
    );
    expect(report.toolsChecked).toBe(2);
    expect(report.argumentsChecked).toBe(3);
  });

  test('reads what an executor reaches only after an answer, when the routes give it', async () => {
    // The space is resolved first ; the identifier travels in the second request.
    const twoSteps: Execute = async (ctx, tool, args) => {
      const space = ident(args.space);
      if (space === null) return declined;
      const res = await ctx.fetch(`${ACME_API}/resolve`, { method: 'GET' });
      const { shard } = (await res.json()) as { shard?: string };
      if (!shard) throw new Error('no shard');
      return send(ctx, 'GET', `/${shard}/spaces/${space}/things`);
    };
    const plugin = acmeWith({ classify: guardedClassify, execute: twoSteps });
    const only = { acme__list_things: SAMPLES.acme__list_things ?? [] };
    await expect(assertIdentifiersRefused(plugin, only, { context })).rejects.toThrow(
      /the proof ran on nothing/,
    );
    const report = await assertIdentifiersRefused(plugin, only, {
      context,
      routes: [{ url: `${ACME_API}/resolve`, body: { shard: 'eu1' } }],
    });
    expect(report.pathIdentifiers).toEqual([{ tool: 'acme__list_things', argument: 'space' }]);
  });
});
