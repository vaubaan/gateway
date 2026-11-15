import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import type { CallDecision } from '../execution/telemetry-sink';
import { decisionReportOf, deploymentKindOf, InstanceProfiler, utcDayOf } from './usage';

const plugin = {
  id: 'cloudflare-dns',
  version: '1.2.0',
  tools: [
    { name: 'cloudflare_dns__list_records', description: 'List.', inputSchema: { type: 'object' } },
  ],
};
const registry = {
  ids: ['cloudflare-dns'],
  get: (id: string) => (id === plugin.id ? { plugin } : undefined),
} as unknown as Pick<PluginRegistry, 'ids' | 'get'>;

function decision(overrides: Partial<CallDecision> = {}): CallDecision {
  return {
    tool: 'cloudflare_dns__list_records',
    decision: 'allowed',
    risksTouched: ['cloudflare-dns.read-records'],
    gated: false,
    ...overrides,
  };
}

describe('decisionReportOf', () => {
  it('builds the report of a declared tool, risks without their environment', () => {
    expect(
      decisionReportOf(
        decision({
          decision: 'approval-required',
          risksTouched: ['cloudflare-dns[prod].record-write', 'cloudflare-dns.read-records'],
          gated: true,
        }),
        registry,
        '2.0.0',
      ),
    ).toEqual({
      plugin: 'cloudflare-dns',
      tool: 'cloudflare_dns__list_records',
      gateway_version: '2.0.0',
      decision: 'approval-required',
      risks: ['cloudflare-dns.read-records', 'cloudflare-dns.record-write'],
      gate: 'approval',
    });
  });

  it('names the plugin by its prefix and drops a tool name it does not declare', () => {
    const report = decisionReportOf(
      decision({ tool: 'cloudflare_dns__drop_everything', decision: 'risk-not-accepted' }),
      registry,
      'dev',
    );
    expect(report).toMatchObject({ plugin: 'cloudflare-dns', tool: null });
  });

  it('reports nothing for a refusal without a code, a wrong door, or a tool of no plugin', () => {
    expect(decisionReportOf(decision({ decision: null }), registry, 'dev')).toBeNull();
    expect(
      decisionReportOf(decision({ decision: 'wrong-credential-kind' }), registry, 'dev'),
    ).toBeNull();
    expect(decisionReportOf(decision({ tool: 'acme__secret' }), registry, 'dev')).toBeNull();
  });
});

describe('deploymentKindOf', () => {
  it('tells Railway, Fly, Docker and the rest apart from the environment', () => {
    expect(deploymentKindOf({ RAILWAY_PROJECT_ID: 'p' }, () => true)).toBe('railway');
    expect(deploymentKindOf({ FLY_APP_NAME: 'a' }, () => true)).toBe('fly');
    expect(deploymentKindOf({}, () => true)).toBe('docker');
    expect(deploymentKindOf({}, () => false)).toBe('other');
  });
});

describe('InstanceProfiler', () => {
  const source = {
    users: () => Promise.resolve(7),
    activeMissions: () => Promise.resolve(1),
    accountsByService: () => Promise.resolve({ 'cloudflare-dns': 2 }),
  };

  it('puts the stored instance identifier on every profile, whatever the day', async () => {
    const id = '0123456789abcdef0123456789abcdef';
    const profiler = new InstanceProfiler({
      registry,
      gatewayVersion: 'dev',
      signInKinds: ['github'],
      source,
      instanceId: () => Promise.resolve(id),
    });
    const today = await profiler.profile(new Date('2026-10-16T23:59:59Z'));
    const tomorrow = await profiler.profile(new Date('2026-10-17T00:00:00Z'));
    expect(today?.instance_id).toBe(id);
    expect(tomorrow?.instance_id).toBe(id);
    expect(utcDayOf(new Date('2026-10-16T23:59:59Z'))).toBe('2026-10-16');
  });

  it('buckets every count and starts the call counter again after a profile', async () => {
    const profiler = new InstanceProfiler({
      registry,
      gatewayVersion: 'dev',
      signInKinds: ['oidc', 'github'],
      source,
      instanceId: () => Promise.resolve('f'.repeat(32)),
      env: {},
      inDocker: () => true,
    });
    for (let n = 0; n < 3; n += 1) profiler.countCall();
    const now = new Date('2026-10-16T12:00:00Z');
    expect(await profiler.profile(now)).toMatchObject({
      deployment: 'docker',
      sign_in_kinds: ['github', 'oidc'],
      users: '6-20',
      active_missions: '1',
      calls: '2-5',
      plugins: [{ plugin: 'cloudflare-dns', plugin_version: '1.2.0', accounts: '2-5' }],
    });
    expect((await profiler.profile(now))?.calls).toBe('0');
  });
});
