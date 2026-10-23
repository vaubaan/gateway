import { describe, expect, it, vi } from 'vitest';

import { collectorEndpoint, TELEMETRY_USER_AGENT, TelemetryClient } from './client.ts';
import { createPluginReport, PLUGIN_REPORT_KEYS } from './report.ts';
import type { TelemetryReport } from './wire.ts';

const COLLECTOR = new URL('https://collector.example.net/rest/v1/plugin_reports?apikey=pk_public');

function report(tool = 'depot__read_item'): TelemetryReport {
  const built = createPluginReport({
    plugin: 'depot',
    plugin_version: '1.0.0',
    gateway_version: 'dev',
    tool,
    outcome: 'upstream-error',
    error_class: 'http_503',
    duration_bucket: 'lt_1s',
  });
  if (!built) throw new Error('fixture report refused');
  return { kind: 'plugin-health', report: built };
}

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

function rig(options: {
  enabled?: boolean | (() => boolean);
  collectorUrl?: URL;
  respond?: (call: number) => Response | Promise<Response>;
}) {
  const sent: Sent[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), init: init ?? {} });
    return options.respond ? options.respond(sent.length) : new Response(null, { status: 201 });
  });
  const logger = { warn: vi.fn(), debug: vi.fn() };
  const enabled = options.enabled ?? true;
  const client = new TelemetryClient({
    isEnabled: typeof enabled === 'function' ? enabled : () => enabled,
    collectorUrl: options.collectorUrl ?? COLLECTOR,
    fetch: fetchMock,
    logger,
    // No timer fires on its own in these tests: every send is an explicit flush.
    queue: { schedule: () => ({ cancel: () => undefined }), random: () => 0 },
  });
  return { client, sent, fetchMock, logger };
}

describe('TelemetryClient: the gates before the network', () => {
  it('disabled: records nothing and makes zero network calls', async () => {
    const { client, fetchMock, logger } = rig({ enabled: false });
    for (let n = 0; n < 120; n += 1) client.record(report());
    await client.flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.state).toBe('disabled');
    expect(client.stats.queued).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('enabled: queues and sends to the configured collector, without a warning', async () => {
    const { client, sent, logger } = rig({ enabled: true });
    client.record(report());
    await client.flush();

    expect(client.state).toBe('sending');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://collector.example.net/rest/v1/plugin_reports');
    expect(sent[0]?.init.method).toBe('POST');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a report queued while enabled never leaves once telemetry is switched off', async () => {
    let enabled = true;
    const { client, fetchMock } = rig({ enabled: () => enabled });
    client.record(report());
    client.record(report());
    expect(client.stats.queued).toBe(2);

    enabled = false;
    await client.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.stats.queued).toBe(0);
  });

  it('discardQueued() empties the queue', async () => {
    const { client, fetchMock } = rig({});
    client.record(report());
    client.discardQueued();
    await client.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('TelemetryClient: the request', () => {
  it('posts the batch grouped by kind, each report with its own keys and nothing else', async () => {
    const { client, sent } = rig({});
    client.record(report('depot__read_item'));
    client.record(report('depot__write_item'));
    await client.flush();

    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.init.method).toBe('POST');
    const body = JSON.parse(String(request?.init.body)) as Record<
      string,
      Record<string, unknown>[]
    >;
    expect(Object.keys(body)).toEqual(['plugin_health']);
    expect(body.plugin_health).toHaveLength(2);
    for (const item of body.plugin_health ?? []) {
      expect(Object.keys(item)).toEqual([...PLUGIN_REPORT_KEYS]);
    }
    expect(client.stats.delivered).toBe(2);
  });

  it('moves the public key from the URL to the headers and sends no other identity', async () => {
    const { client, sent } = rig({});
    client.record(report());
    await client.flush();

    const [request] = sent;
    expect(request?.url).toBe('https://collector.example.net/rest/v1/plugin_reports');
    expect(request?.init.headers).toEqual({
      'user-agent': TELEMETRY_USER_AGENT,
      apikey: 'pk_public',
      authorization: 'Bearer pk_public',
      'content-type': 'application/json',
      prefer: 'return=minimal',
    });
    expect(request?.init.redirect).toBe('error');
    expect(request?.init.credentials).toBe('omit');
    expect(request?.init.referrerPolicy).toBe('no-referrer');
  });

  it('sends no key header when the URL carries none', async () => {
    const { client, sent } = rig({
      collectorUrl: new URL('https://telemetry.example.org/v1/plugin_reports'),
    });
    client.record(report());
    await client.flush();
    expect(Object.keys(sent[0]?.init.headers ?? {}).sort()).toEqual([
      'content-type',
      'prefer',
      'user-agent',
    ]);
    expect(collectorEndpoint(COLLECTOR)).toEqual({
      url: new URL('https://collector.example.net/rest/v1/plugin_reports'),
      key: 'pk_public',
    });
  });

  it.each([429, 408, 500, 503])('keeps the batch and retries after HTTP %i', async (status) => {
    const { client, sent } = rig({
      respond: (call) => new Response(null, { status: call === 1 ? status : 201 }),
    });
    client.record(report());
    await client.flush();
    expect(client.stats).toMatchObject({ queued: 1, failures: 1, delivered: 0 });
    await client.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.init.body).toBe(sent[0]?.init.body);
    expect(client.stats).toMatchObject({ queued: 0, failures: 0, delivered: 1 });
  });

  it('retries when the collector cannot be reached', async () => {
    const { client } = rig({
      respond: () => {
        throw new TypeError('fetch failed');
      },
    });
    client.record(report());
    await client.flush();
    expect(client.stats).toMatchObject({ queued: 1, failures: 1 });
  });

  it.each([400, 401, 403, 404])(
    'drops a batch the collector refuses with HTTP %i, and says so once',
    async (status) => {
      const { client, sent, logger } = rig({ respond: () => new Response('nope', { status }) });
      client.record(report());
      await client.flush();
      client.record(report());
      await client.flush();
      expect(sent).toHaveLength(2);
      expect(client.stats).toMatchObject({ queued: 0, delivered: 0, dropped: 2 });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0]?.[1]).toEqual({ status });
    },
  );
});
