import { describe, expect, test } from 'vitest';

import { parseSlice } from '@vaubaan/policy-engine';
import type { Resource } from '@vaubaan/shared';

import type { ExecuteContext, ProviderPlugin } from '../../src/plugin.ts';
import {
  PluginAssertionError,
  assertCatalogCoverage,
  assertNoWildcard,
  assertPluginWellFormed,
  mockFetch,
} from '../../src/testing/index.ts';
import { ACME_API, acmePlugin } from '../fixtures/acme/acme-plugin.ts';

const staging: Resource = {
  provider: 'acme',
  ref: 'sp-1',
  env: 'staging',
  displayName: 'Staging space',
};

const samples = {
  acme__list_things: [{ args: { space: 'sp-1' } }, { args: {} }],
  acme__update_thing: [{ args: { space: 'sp-1', thing_id: 't-9', name: 'x' } }],
};

describe('assertCatalogCoverage', () => {
  test('passes on the fixture and reports touched risks', () => {
    const report = assertCatalogCoverage(acmePlugin, samples, { resources: [staging] });
    expect(report.toolsChecked).toBe(2);
    expect(report.samplesChecked).toBe(3);
    // The fallback is not co-touched by a categorized write (ADR
    // fallback-risk-only-when-uncategorized) and is reachable by design only
    // through uncategorized writes : it is left out of `risksUntouched`, and a
    // complete catalog leaves `fallbackHits` empty.
    expect(report.risksTouched).toEqual(['acme.read-things', 'acme.thing-write']);
    expect(report.risksUntouched).toEqual(['acme.legacy-export']);
    expect(report.fallbackHits).toEqual([]);
  });

  test('defaults to the samples the plugin declares (examples)', () => {
    const declared: ProviderPlugin = { ...acmePlugin, examples: samples };
    const report = assertCatalogCoverage(declared, undefined, { resources: [staging] });
    expect(report.samplesChecked).toBe(3);
    expect(() => assertCatalogCoverage(acmePlugin)).toThrow(
      /no samples: declare `examples` on the plugin or pass them/,
    );
  });

  test('reports the samples that only the fallback covers', () => {
    const uncategorized: ProviderPlugin = {
      ...acmePlugin,
      tools: [
        ...acmePlugin.tools,
        {
          name: 'acme__purge_space',
          description: 'Purge a space.',
          inputSchema: { type: 'object', properties: { space: { type: 'string' } } },
        },
      ],
      classify: (tool, args, resources) =>
        tool === 'acme__purge_space'
          ? { slices: [parseSlice(`acme.space[${String(args.space)}].purge.W`)] }
          : acmePlugin.classify(tool, args, resources),
    };
    const report = assertCatalogCoverage(
      uncategorized,
      { ...samples, acme__purge_space: [{ args: { space: 'sp-1' } }] },
      { resources: [staging] },
    );
    expect(report.risksTouched).toContain('acme.uncategorized-write');
    expect(report.fallbackHits).toEqual(["'acme__purge_space' sample #1 slice #1"]);
  });

  test('a tool without sample fails', () => {
    expect(() =>
      assertCatalogCoverage(
        acmePlugin,
        { acme__list_things: samples.acme__list_things },
        { resources: [staging] },
      ),
    ).toThrow(/tool 'acme__update_thing' has no sample call/);
  });

  test('a sample for an undeclared tool fails', () => {
    expect(() =>
      assertCatalogCoverage(
        acmePlugin,
        { ...samples, acme__typo: [{ args: {} }] },
        { resources: [staging] },
      ),
    ).toThrow(/sample for 'acme__typo' but the plugin declares no such tool/);
  });

  test('an unexpected classifier denial fails ; an expected one passes', () => {
    const ambiguous = { ...samples, acme__list_things: [{ args: {} }] };
    expect(() =>
      assertCatalogCoverage(acmePlugin, ambiguous, {
        resources: [staging, { ...staging, ref: 'sp-2' }],
      }),
    ).toThrow(/'acme__list_things' sample #1: classifier denied/);
    const expected = { ...samples, acme__list_things: [{ args: {}, expectDenied: true }] };
    expect(() =>
      assertCatalogCoverage(acmePlugin, expected, {
        resources: [staging, { ...staging, ref: 'sp-2' }],
      }),
    ).not.toThrow();
    expect(() =>
      assertCatalogCoverage(
        acmePlugin,
        {
          ...samples,
          acme__update_thing: [{ ...samples.acme__update_thing[0]!, expectDenied: true }],
        },
        { resources: [staging] },
      ),
    ).toThrow(/expected the classifier to deny, got 1 slice/);
  });

  test('a slice no catalog risk matches fails', () => {
    const noReadRisk: ProviderPlugin = {
      ...acmePlugin,
      catalog: {
        ...acmePlugin.catalog,
        risks: acmePlugin.catalog.risks.filter((r) => r.id !== 'acme.read-things'),
        macro_actions: (acmePlugin.catalog.macro_actions ?? []).filter((a) =>
          a.entries.every((e) => e.risk_id !== 'acme.read-things'),
        ),
      },
    };
    const plugin = noReadRisk;
    expect(() => assertCatalogCoverage(plugin, samples, { resources: [staging] })).toThrow(
      /'acme__list_things' sample #1 slice #1: no catalog risk matches it/,
    );
  });

  test('errors are PluginAssertionError with every finding', () => {
    try {
      assertCatalogCoverage(acmePlugin, {}, { resources: [staging] });
    } catch (e) {
      expect(e).toBeInstanceOf(PluginAssertionError);
      expect((e as PluginAssertionError).findings).toHaveLength(2);
      return;
    }
    throw new Error('expected a throw');
  });
});

describe('assertNoWildcard / assertPluginWellFormed', () => {
  test('explicit lists pass, wildcards and sentinels fail', () => {
    expect(() => assertNoWildcard(['acme.read-things', 'acme[prod].thing-write'])).not.toThrow();
    expect(() => assertNoWildcard(['acme.read-things', 'acme.*'])).toThrow(
      /'acme\.\*' is not an explicit RiskId/,
    );
    expect(() => assertNoWildcard(['*'])).toThrow(PluginAssertionError);
    expect(() => assertNoWildcard(['all'])).toThrow(PluginAssertionError);
  });

  test('catalog and plugin forms', () => {
    expect(() => assertNoWildcard(acmePlugin)).not.toThrow();
    expect(() => assertNoWildcard(acmePlugin.catalog)).not.toThrow();
    const wildRisk: ProviderPlugin = {
      ...acmePlugin,
      catalog: {
        ...acmePlugin.catalog,
        risks: [...acmePlugin.catalog.risks, { ...acmePlugin.catalog.risks[0]!, id: 'acme.x-*' }],
      },
    };
    expect(() => assertNoWildcard(wildRisk)).toThrow(
      /risks\[4\]\.id 'acme.x-\*' contains a wildcard/,
    );
  });

  test('well-formedness on the fixture', () => {
    expect(() => assertPluginWellFormed(acmePlugin)).not.toThrow();
    expect(() =>
      assertPluginWellFormed({
        ...acmePlugin,
        catalog: { ...acmePlugin.catalog, presets: [] },
      } as ProviderPlugin),
    ).toThrow(/presets were retired/);
    expect(() => assertPluginWellFormed({ ...acmePlugin, version: 'x' })).toThrow(
      /version: expected semver/,
    );
    // The kit holds a plugin to the explicit flag the loader only warns about.
    const unflagged: ProviderPlugin = {
      ...acmePlugin,
      catalog: {
        ...acmePlugin.catalog,
        risks: acmePlugin.catalog.risks.map((r) =>
          r.id === 'acme.uncategorized-write' ? { ...r, fallback: undefined } : r,
        ),
      },
    };
    expect(() => assertPluginWellFormed(unflagged)).toThrow(
      /is the fallback by convention only — set fallback: true/,
    );
  });
});

describe('mockFetch', () => {
  const ctx = (fetch: typeof globalThis.fetch): ExecuteContext => ({
    credential: { kind: 'api-key', fields: { api_key: 'secret-k' }, metadata: {} },
    fetch,
    resources: [staging],
  });

  test('routes by method and URL, records calls, serializes JSON bodies', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${ACME_API}/spaces/sp-1/things`, body: [{ id: 't-1' }] },
      { method: 'PATCH', url: /\/things\/t-9$/, respond: (call) => ({ ok: true, got: call.json }) },
    ]);
    const list = await acmePlugin.execute(ctx(fetch), 'acme__list_things', { space: 'sp-1' });
    expect(list.content[0]).toEqual({ type: 'text', text: '[{"id":"t-1"}]' });
    const upd = await acmePlugin.execute(ctx(fetch), 'acme__update_thing', {
      space: 'sp-1',
      thing_id: 't-9',
      name: 'new',
    });
    expect(JSON.parse((upd.content[0] as { text: string }).text)).toEqual({
      ok: true,
      got: { name: 'new' },
    });

    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]!.method).toBe('GET');
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer secret-k');
    expect(fetch.calls[1]!.body).toBe('{"name":"new"}');
  });

  test('an unmatched request rejects — no accidental network', async () => {
    const fetch = mockFetch([]);
    await expect(
      acmePlugin.execute(ctx(fetch), 'acme__list_things', { space: 'sp-1' }),
    ).rejects.toThrow(
      /mockFetch: unexpected GET https:\/\/api\.acme\.test\/v1\/spaces\/sp-1\/things/,
    );
  });

  test('status codes drive UpstreamAuthError and pending() tracks `times`', async () => {
    const fetch = mockFetch([
      { url: /things$/, status: 401, body: { message: 'bad credentials' }, times: 1 },
      { url: /spaces$/, body: [{ id: 'sp-1', name: 'Staging' }], times: 2 },
    ]);
    await expect(
      acmePlugin.execute(ctx(fetch), 'acme__list_things', { space: 'sp-1' }),
    ).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
    expect(fetch.pending()).toHaveLength(1);
    const resources = await acmePlugin.discoverResources(ctx(fetch));
    expect(resources).toEqual([{ provider: 'acme', ref: 'sp-1', displayName: 'Staging' }]);
    expect(fetch.pending()).toHaveLength(1);
    await acmePlugin.discoverResources(ctx(fetch));
    expect(fetch.pending()).toHaveLength(0);
    // Exhausted route no longer answers.
    await expect(acmePlugin.discoverResources(ctx(fetch))).rejects.toThrow(/unexpected GET/);
  });

  test('accepts Request objects, Headers and text bodies', async () => {
    const fetch = mockFetch([
      { url: 'https://x.test/echo', body: 'pong', headers: { 'x-trace': '1' } },
    ]);
    const res = await fetch(
      new Request('https://x.test/echo', {
        method: 'POST',
        body: 'ping',
        headers: new Headers({ 'X-Agent': 'a' }),
      }),
    );
    expect(await res.text()).toBe('pong');
    expect(res.headers.get('x-trace')).toBe('1');
    expect(fetch.calls[0]).toMatchObject({
      method: 'POST',
      body: 'ping',
      headers: { 'x-agent': 'a' },
      json: undefined,
    });
  });
});
