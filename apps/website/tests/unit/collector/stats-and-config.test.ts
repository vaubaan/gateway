import { describe, expect, it } from 'vitest';

import {
  CollectorConfigError,
  isCollectorHost,
  readCollectorConfig,
} from '../../../src/collector/config';
import {
  handleInstances,
  handleStats,
  instancesParams,
  statsParams,
} from '../../../src/collector/stats';
import { createSupabaseRest, type SupabaseRest } from '../../../src/collector/supabase';

const ENV = {
  COLLECTOR_HOST: 'telemetry.vaubaan.com',
  COLLECTOR_SUPABASE_URL: 'https://abc.supabase.co',
  COLLECTOR_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_xyz',
};

describe('collector: configuration', () => {
  it('names the missing variable', () => {
    for (const name of Object.keys(ENV)) {
      expect(() => readCollectorConfig({ ...ENV, [name]: undefined })).toThrow(name);
    }
  });

  it('refuses a secret key and a plain-http store', () => {
    expect(() =>
      readCollectorConfig({ ...ENV, COLLECTOR_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc' }),
    ).toThrow(CollectorConfigError);
    expect(() =>
      readCollectorConfig({ ...ENV, COLLECTOR_SUPABASE_URL: 'http://abc.supabase.co' }),
    ).toThrow(CollectorConfigError);
  });

  it('answers on its own host only', () => {
    const config = readCollectorConfig(ENV);
    const on = (host: string) =>
      isCollectorHost(new Request('https://x/v1/reports', { headers: { host } }), config);
    expect(on('telemetry.vaubaan.com')).toBe(true);
    expect(on('TELEMETRY.vaubaan.com:443')).toBe(true);
    expect(on('vaubaan.com')).toBe(false);
    expect(on('telemetry.vaubaan.com.evil.example')).toBe(false);
  });
});

describe('collector: GET /v1/plugin_stats', () => {
  it('passes on the query the gateway client builds', () => {
    const params = statsParams(
      new URLSearchParams({
        select: 'plugin,plugin_version,reports,success_rate,validated',
        tool: 'is.null',
        plugin: 'in.(github,supabase)',
      }),
    );
    expect(params?.toString()).toBe(
      'select=plugin%2Cplugin_version%2Creports%2Csuccess_rate%2Cvalidated&tool=is.null&plugin=in.%28github%2Csupabase%29',
    );
  });

  it.each([
    ['an unknown parameter', { order: 'reports.desc' }],
    ['an unknown column', { select: 'plugin,*' }],
    ['another filter on tool', { tool: 'eq.github__x' }],
    ['a plugin id that is not one', { plugin: 'in.(github,DROP)' }],
    ['a plugin filter that is not a list', { plugin: 'eq.github' }],
  ])('refuses %s', (_name, query) => {
    expect(statsParams(new URLSearchParams(query))).toBeNull();
  });

  it('serves the rows with an hour of edge cache, and 503 when the store does not answer', async () => {
    const rows = [{ plugin: 'github', plugin_version: '3.0.0', tool: null, reports: 3 }];
    const store = (answer: unknown): SupabaseRest => ({
      insert: () => Promise.resolve('stored'),
      select: () => Promise.resolve(answer),
    });
    const ok = await handleStats(
      new Request('https://telemetry.vaubaan.com/v1/plugin_stats?tool=is.null'),
      { store: store(rows) },
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toContain('s-maxage=3600');
    expect(await ok.json()).toEqual(rows);
    const down = await handleStats(new Request('https://telemetry.vaubaan.com/v1/plugin_stats'), {
      store: store(null),
    });
    expect(down.status).toBe(503);
  });
});

describe('collector: GET /v1/plugin_stats, the site read', () => {
  it('passes on the credential rejections the success rate leaves out', () => {
    expect(
      statsParams(
        new URLSearchParams({ select: 'plugin,reports,credential_rejections', tool: 'is.null' }),
      )?.get('select'),
    ).toBe('plugin,reports,credential_rejections');
  });
});

describe('collector: GET /v1/plugin_instances', () => {
  it('passes on a select among its columns and a plugin list, every column by default', () => {
    expect(instancesParams(new URLSearchParams())?.toString()).toBe(
      'select=plugin%2Cplugin_version%2Cplugin_minor%2Cinstances',
    );
    expect(
      instancesParams(
        new URLSearchParams({ select: 'plugin,plugin_minor,instances', plugin: 'in.(github)' }),
      )?.toString(),
    ).toBe('select=plugin%2Cplugin_minor%2Cinstances&plugin=in.%28github%29');
  });

  it.each([
    ['a tool filter, which the view has no column for', { tool: 'is.null' }],
    ['a column of plugin_stats', { select: 'plugin,reports' }],
    ['an unknown parameter', { order: 'instances.desc' }],
    ['a plugin id that is not one', { plugin: 'in.(github,DROP)' }],
  ])('refuses %s', (_name, query) => {
    expect(instancesParams(new URLSearchParams(query))).toBeNull();
  });

  it('reads the plugin_instances view, with an hour of edge cache, and 503 when the store does not answer', async () => {
    const rows = [{ plugin: 'github', plugin_version: null, plugin_minor: '4.0', instances: 3 }];
    const views: string[] = [];
    const store = (answer: unknown): SupabaseRest => ({
      insert: () => Promise.resolve('stored'),
      select: (view) => {
        views.push(view);
        return Promise.resolve(answer);
      },
    });
    const ok = await handleInstances(
      new Request('https://telemetry.vaubaan.com/v1/plugin_instances'),
      { store: store(rows) },
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toContain('s-maxage=3600');
    expect(await ok.json()).toEqual(rows);
    expect(views).toEqual(['plugin_instances']);
    const bad = await handleInstances(
      new Request('https://telemetry.vaubaan.com/v1/plugin_instances?tool=is.null'),
      { store: store(rows) },
    );
    expect(bad.status).toBe(400);
    const down = await handleInstances(
      new Request('https://telemetry.vaubaan.com/v1/plugin_instances'),
      { store: store(null) },
    );
    expect(down.status).toBe(503);
  });
});

describe('collector: the store client', () => {
  it('sends the publishable key and nothing of the instance', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = ((url: URL, init: RequestInit) => {
      calls.push({ url: url.href, init });
      return Promise.resolve(new Response(null, { status: 201 }));
    }) as unknown as typeof fetch;
    const store = createSupabaseRest(readCollectorConfig(ENV), fetchImpl);
    expect(await store.insert('plugin_reports', [{ plugin: 'github' }])).toBe('stored');
    expect(calls[0]?.url).toBe('https://abc.supabase.co/rest/v1/plugin_reports');
    expect(calls[0]?.init.headers).toEqual({
      apikey: 'sb_publishable_xyz',
      authorization: 'Bearer sb_publishable_xyz',
      'content-type': 'application/json',
      prefer: 'return=minimal',
    });
  });

  it('maps the store statuses', async () => {
    const answering = (status: number) =>
      createSupabaseRest(readCollectorConfig(ENV), () =>
        Promise.resolve(new Response(null, { status })),
      );
    expect(await answering(429).insert('t', [{}])).toBe('rate-limited');
    expect(await answering(400).insert('t', [{}])).toBe('refused');
    expect(await answering(500).insert('t', [{}])).toBe('unavailable');
    const failing = createSupabaseRest(readCollectorConfig(ENV), () =>
      Promise.reject(new Error('down')),
    );
    expect(await failing.insert('t', [{}])).toBe('unavailable');
  });
});
