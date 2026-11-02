import { describe, expect, it } from 'vitest';

import { createPluginReport, type PluginReport } from './report.ts';
import { createDecisionReport, createInstanceProfile, type DecisionReport } from './usage.ts';
import { MAX_REPORTS_PER_BATCH, parseBatch, serializeBatch, type TelemetryReport } from './wire.ts';

function health(tool = 'github__get_file_contents'): PluginReport {
  const report = createPluginReport({
    plugin: 'github',
    plugin_version: '3.0.0',
    gateway_version: '2.0.0',
    tool,
    outcome: 'success',
    error_class: null,
    duration_bucket: 'lt_1s',
  });
  if (!report) throw new Error('fixture refused');
  return report;
}

function decision(): DecisionReport {
  const report = createDecisionReport({
    plugin: 'github',
    tool: 'github__create_pull_request',
    gateway_version: '2.0.0',
    decision: 'allowed',
    risks: ['github.create-pr'],
    gate: 'none',
  });
  if (!report) throw new Error('fixture refused');
  return report;
}

const profile = createInstanceProfile({
  instance_id: 'ffffffffffffffffffffffffffffffff',
  gateway_version: '2.0.0',
  deployment: 'docker',
  runtime: 'node-22',
  arch: 'arm64',
  sign_in_kinds: ['oidc'],
  users: '1',
  active_missions: '1',
  calls: '2-5',
  plugins: [{ plugin: 'github', plugin_version: '3.0.0', accounts: '1' }],
});

describe('wire: serializeBatch', () => {
  it('groups queued reports by kind and leaves out empty kinds', () => {
    const queued: TelemetryReport[] = [
      { kind: 'plugin-health', report: health() },
      { kind: 'decision', report: decision() },
    ];
    expect(JSON.parse(serializeBatch(queued))).toEqual({
      plugin_health: [health()],
      decisions: [decision()],
    });
  });

  it('rebuilds every report: a key smuggled by a cast never leaves', () => {
    const cast = { ...health(), arguments_hash: 'f'.repeat(64) } as unknown as PluginReport;
    const body = JSON.parse(serializeBatch([{ kind: 'plugin-health', report: cast }])) as {
      plugin_health: object[];
    };
    expect(body.plugin_health).toEqual([health()]);
  });

  it('round-trips through the collector parser', () => {
    if (!profile) throw new Error('fixture refused');
    const body = serializeBatch([
      { kind: 'plugin-health', report: health() },
      { kind: 'decision', report: decision() },
      { kind: 'instance-profile', report: profile },
    ]);
    expect(parseBatch(JSON.parse(body))).toEqual({
      plugin_health: [health()],
      decisions: [decision()],
      instance_profiles: [profile],
    });
  });
});

describe('wire: parseBatch, the collector side', () => {
  it('refuses the whole batch when one report carries a key its shape does not define', () => {
    expect(
      parseBatch({ plugin_health: [health(), { ...health(), mission_id: 'mis_1' }] }),
    ).toBeNull();
  });

  it('refuses the whole batch when one value fails its constructor', () => {
    expect(
      parseBatch({ decisions: [{ ...decision(), risks: ['github[prod].git-push'] }] }),
    ).toBeNull();
  });

  it('refuses a key the batch does not define, and a JSON array (the old wire)', () => {
    expect(parseBatch({ plugin_health: [health()], instance: 'acme' })).toBeNull();
    expect(parseBatch([health()])).toBeNull();
  });

  it('refuses a plugin entry of a profile that smuggles a key', () => {
    if (!profile) throw new Error('fixture refused');
    const entry = { ...profile.plugins[0], org: 'acme' };
    expect(parseBatch({ instance_profiles: [{ ...profile, plugins: [entry] }] })).toBeNull();
  });

  it('reads the day_id of a gateway up to 2.0.0-alpha.12 as its instance_id', () => {
    if (!profile) throw new Error('fixture refused');
    const { instance_id: id, ...rest } = profile;
    const legacy = { ...rest, day_id: id };
    expect(parseBatch({ plugin_health: [health()], instance_profiles: [legacy] })).toEqual({
      plugin_health: [health()],
      decisions: [],
      instance_profiles: [profile],
    });
    // Both keys at once is not a client of this project.
    expect(parseBatch({ instance_profiles: [{ ...profile, day_id: id }] })).toBeNull();
  });

  it('refuses an empty batch and one larger than the bound', () => {
    expect(parseBatch({})).toBeNull();
    const many = Array.from({ length: MAX_REPORTS_PER_BATCH + 1 }, () => health());
    expect(parseBatch({ plugin_health: many })).toBeNull();
    expect(parseBatch({ plugin_health: many.slice(1) })).not.toBeNull();
  });

  it('refuses values that are not plain objects', () => {
    expect(parseBatch(null)).toBeNull();
    expect(parseBatch('{}')).toBeNull();
    expect(parseBatch({ plugin_health: 'x' })).toBeNull();
  });
});
