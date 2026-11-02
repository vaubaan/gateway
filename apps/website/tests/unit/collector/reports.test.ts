import {
  createDecisionReport,
  createInstanceProfile,
  createPluginReport,
  serializeBatch,
  type TelemetryReport,
} from '@vaubaan/telemetry';
import { describe, expect, it } from 'vitest';

import { handleReports, MAX_BODY_BYTES, rowsOf } from '../../../src/collector/reports';
import type { StoreResult, SupabaseRest } from '../../../src/collector/supabase';

function must<T>(value: T | null): T {
  if (value === null) throw new Error('fixture refused');
  return value;
}

const health = must(
  createPluginReport({
    plugin: 'github',
    plugin_version: '3.0.0',
    gateway_version: '2.0.0',
    tool: 'github__get_file_contents',
    outcome: 'upstream-error',
    error_class: 'http_404',
    duration_bucket: 'lt_1s',
  }),
);
const decision = must(
  createDecisionReport({
    plugin: 'github',
    tool: 'github__create_pull_request',
    gateway_version: '2.0.0',
    decision: 'budget-exhausted',
    risks: ['github.create-pr'],
    gate: 'none',
  }),
);
const profile = must(
  createInstanceProfile({
    instance_id: 'abcdefabcdefabcdefabcdefabcdefab',
    gateway_version: '2.0.0',
    deployment: 'railway',
    runtime: 'node-22',
    arch: 'x64',
    sign_in_kinds: ['github'],
    users: '2-5',
    active_missions: '1',
    calls: '21-100',
    plugins: [
      { plugin: 'github', plugin_version: '3.0.0', accounts: '1' },
      { plugin: 'supabase', plugin_version: '4.1.0', accounts: '1' },
    ],
  }),
);

const ALL: TelemetryReport[] = [
  { kind: 'plugin-health', report: health },
  { kind: 'decision', report: decision },
  { kind: 'instance-profile', report: profile },
];

function rig(results: Partial<Record<string, StoreResult>> = {}) {
  const inserts: { table: string; rows: readonly object[] }[] = [];
  const logs: Record<string, number | string>[] = [];
  const store: SupabaseRest = {
    insert: (table, rows) => {
      inserts.push({ table, rows });
      return Promise.resolve(results[table] ?? 'stored');
    },
    select: () => Promise.resolve([]),
  };
  return {
    deps: { store, log: (line: Record<string, number | string>) => logs.push(line) },
    inserts,
    logs,
  };
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://telemetry.vaubaan.com/v1/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('collector: POST /v1/reports', () => {
  it('stores each kind in its table and answers 202 with no body', async () => {
    const { deps, inserts } = rig();
    const response = await handleReports(post(serializeBatch(ALL)), deps);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect(inserts.map((i) => i.table)).toEqual([
      'plugin_reports',
      'decision_reports',
      'instance_profiles',
      'instance_profile_plugins',
    ]);
    expect(inserts[2]?.rows[0]).not.toHaveProperty('plugins');
    expect(inserts[3]?.rows).toEqual([
      {
        instance_id: profile.instance_id,
        plugin: 'github',
        plugin_version: '3.0.0',
        accounts: '1',
      },
      {
        instance_id: profile.instance_id,
        plugin: 'supabase',
        plugin_version: '4.1.0',
        accounts: '1',
      },
    ]);
  });

  it('writes only the columns the report defines: nothing of the request is added', async () => {
    const { deps, inserts } = rig();
    await handleReports(
      post(serializeBatch(ALL), {
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '203.0.113.9',
        'user-agent': 'acme-gateway',
      }),
      deps,
    );
    const stored = JSON.stringify(inserts);
    expect(stored).not.toContain('203.0.113.9');
    expect(stored).not.toContain('acme');
    expect(
      Object.keys(
        rowsOf({ plugin_health: [health], decisions: [], instance_profiles: [] })
          .plugin_reports?.[0] ?? {},
      ),
    ).toEqual(Object.keys(health));
  });

  it('refuses the whole batch, stores nothing, when one report carries an extra key', async () => {
    const { deps, inserts, logs } = rig();
    const body = JSON.stringify({ plugin_health: [health, { ...health, mission_id: 'mis_1' }] });
    expect((await handleReports(post(body), deps)).status).toBe(400);
    expect(inserts).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain('mis_1');
  });

  it('refuses what is not JSON, a wrong content type and a body past the bound', async () => {
    const { deps, inserts } = rig();
    expect((await handleReports(post('{not json'), deps)).status).toBe(400);
    expect((await handleReports(post('{}', { 'content-type': 'text/plain' }), deps)).status).toBe(
      415,
    );
    const big = JSON.stringify({ plugin_health: [], pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect((await handleReports(post(big), deps)).status).toBe(413);
    expect(inserts).toEqual([]);
  });

  it('answers 429 when the store limits ingestion, 503 when it is down or out of step', async () => {
    expect(
      (await handleReports(post(serializeBatch(ALL)), rig({ plugin_reports: 'rate-limited' }).deps))
        .status,
    ).toBe(429);
    expect(
      (
        await handleReports(
          post(serializeBatch(ALL)),
          rig({ decision_reports: 'unavailable' }).deps,
        )
      ).status,
    ).toBe(503);
    expect(
      (await handleReports(post(serializeBatch(ALL)), rig({ instance_profiles: 'refused' }).deps))
        .status,
    ).toBe(503);
  });

  it('logs a count and a result, never a value of a report', async () => {
    const { deps, logs } = rig();
    await handleReports(post(serializeBatch(ALL)), deps);
    expect(logs).toEqual([{ event: 'batch', reports: 3, result: 'stored' }]);
  });
});
