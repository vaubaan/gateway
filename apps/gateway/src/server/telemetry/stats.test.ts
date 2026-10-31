import { MemoryCacheClient } from '@vaubaan/gateway-core';
import { createRegistry } from '@vaubaan/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { fakePlugin } from '../../../tests/support/compose/testing';
import { silentLogger } from '../logging';
import {
  FAILURE_TTL_SECONDS,
  parsePluginStats,
  PluginStatsReader,
  pluginStatsUrl,
  STATS_TTL_SECONDS,
} from './stats';

const COLLECTOR = new URL('https://collector.example.net/rest/v1/plugin_reports?apikey=pk_public');

function rig(options: { active?: boolean; respond?: () => Response | Promise<Response> } = {}) {
  let nowMs = 0;
  const plugin = fakePlugin();
  const registry = createRegistry([plugin]);
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: new URL(String(input)), init: init ?? {} });
    if (options.respond) return options.respond();
    return Response.json([
      {
        plugin: plugin.id,
        plugin_version: plugin.version,
        reports: 412,
        success_rate: 0.9731,
        validated: true,
      },
      { plugin: plugin.id, plugin_version: '0.0.9', reports: 3, success_rate: 1, validated: false },
    ]);
  });
  let active = options.active ?? true;
  const reader = new PluginStatsReader({
    isActive: () => active,
    collectorUrl: COLLECTOR,
    registry,
    cache: new MemoryCacheClient({ now: () => nowMs }),
    fetch: fetchMock,
    logger: silentLogger,
  });
  return {
    reader,
    plugin,
    requests,
    fetchMock,
    advanceSeconds: (seconds: number) => {
      nowMs += seconds * 1000;
    },
    setActive: (value: boolean) => {
      active = value;
    },
  };
}

describe('PluginStatsReader', () => {
  it('asks for the plugin-level rows of the registered plugins, key in the headers', async () => {
    const { reader, plugin, requests } = rig();
    await reader.refresh();

    const [request] = requests;
    expect(`${request?.url.origin}${request?.url.pathname}`).toBe(
      'https://collector.example.net/rest/v1/plugin_stats',
    );
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      select: 'plugin,plugin_version,reports,success_rate,validated',
      tool: 'is.null',
      plugin: `in.(${plugin.id})`,
    });
    expect(request?.init.method).toBe('GET');
    expect(request?.init.headers).toMatchObject({
      apikey: 'pk_public',
      authorization: 'Bearer pk_public',
    });
    expect(request?.init.redirect).toBe('error');
  });

  it('answers nothing on the first read, without waiting, then the status of the running version', async () => {
    const { reader, plugin, fetchMock } = rig();
    expect(await reader.statusFor(plugin.id)).toBeNull();
    await reader.refresh(); // joins the refresh the read started
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await reader.statusFor(plugin.id)).toEqual({
      validated: true,
      reports: 412,
      successRate: 0.9731,
    });
    expect(await reader.statusFor('not-registered')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves the cache for its lifetime, then fetches again', async () => {
    const { reader, plugin, fetchMock, advanceSeconds } = rig();
    await reader.refresh();
    advanceSeconds(STATS_TTL_SECONDS - 1);
    expect(await reader.statusFor(plugin.id)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    advanceSeconds(2);
    expect(await reader.statusFor(plugin.id)).toBeNull();
    await reader.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await reader.statusFor(plugin.id)).not.toBeNull();
  });

  it.each([
    ['an error status', () => new Response('down', { status: 503 })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a body that is not a list', () => Response.json({ message: 'permission denied' })],
    [
      'an unreachable collector',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('shows nothing after %s, and does not ask again for a while', async (_name, respond) => {
    const { reader, plugin, fetchMock, advanceSeconds } = rig({ respond });
    await reader.refresh();
    expect(await reader.statusFor(plugin.id)).toBeNull();
    expect(await reader.statusFor(plugin.id)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    advanceSeconds(FAILURE_TTL_SECONDS + 1);
    await reader.statusFor(plugin.id);
    await reader.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('makes no request at all while telemetry is not sending', async () => {
    const { reader, plugin, fetchMock, setActive } = rig({ active: false });
    expect(await reader.statusFor(plugin.id)).toBeNull();
    await reader.refresh();
    expect(fetchMock).not.toHaveBeenCalled();

    // Cached statistics are not shown either once telemetry is switched off.
    setActive(true);
    await reader.refresh();
    expect(await reader.statusFor(plugin.id)).not.toBeNull();
    setActive(false);
    expect(await reader.statusFor(plugin.id)).toBeNull();
  });

  it('shares one request between concurrent refreshes', async () => {
    const { reader, fetchMock } = rig();
    await Promise.all([reader.refresh(), reader.refresh(), reader.refresh()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('pluginStatsUrl / parsePluginStats', () => {
  it('replaces the last path segment and drops the key from the URL', () => {
    const url = pluginStatsUrl(COLLECTOR, ['github', 'cloudflare-dns']);
    expect(url.pathname).toBe('/rest/v1/plugin_stats');
    expect(url.searchParams.get('apikey')).toBeNull();
    expect(url.searchParams.get('plugin')).toBe('in.(github,cloudflare-dns)');
  });

  it('skips malformed rows and refuses a body that is not a list', () => {
    expect(parsePluginStats({})).toBeNull();
    expect(
      parsePluginStats([
        {
          plugin: 'github',
          plugin_version: '1.0.0',
          reports: 10,
          success_rate: 0.5,
          validated: false,
        },
        {
          plugin: 'github',
          plugin_version: '1.0.1',
          reports: -1,
          success_rate: 0.5,
          validated: false,
        },
        {
          plugin: 'github',
          plugin_version: '1.0.2',
          reports: 10,
          success_rate: 7,
          validated: true,
        },
        {
          plugin: 'github',
          plugin_version: '1.0.3',
          reports: 10,
          success_rate: 1,
          validated: 'yes',
        },
        {
          plugin: 'Git Hub',
          plugin_version: '1.0.4',
          reports: 10,
          success_rate: 1,
          validated: true,
        },
        'not a row',
        null,
      ]),
    ).toEqual({ 'github@1.0.0': { validated: false, reports: 10, successRate: 0.5 } });
  });
});
