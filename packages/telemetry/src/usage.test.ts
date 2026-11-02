import { describe, expect, it } from 'vitest';

import {
  countBucket,
  createDecisionReport,
  createInstanceProfile,
  DECISION_OUTCOMES,
  DECISION_REPORT_KEYS,
  INSTANCE_PROFILE_KEYS,
  type DecisionReportInput,
  type InstanceProfileInput,
} from './usage.ts';

const DECISION: DecisionReportInput = {
  plugin: 'supabase',
  tool: 'supabase__apply_migration',
  gateway_version: '2.0.0',
  decision: 'approval-required',
  risks: ['supabase.migration-write', 'supabase.policy-write'],
  gate: 'approval',
};

const PROFILE: InstanceProfileInput = {
  instance_id: '0123456789abcdef0123456789abcdef',
  gateway_version: '2.0.0',
  deployment: 'railway',
  runtime: 'node-22',
  arch: 'x64',
  sign_in_kinds: ['github', 'oidc'],
  users: '2-5',
  active_missions: '6-20',
  calls: '101-1000',
  plugins: [
    { plugin: 'supabase', plugin_version: '4.1.0', accounts: '1' },
    { plugin: 'github', plugin_version: '3.0.0', accounts: '1' },
  ],
};

describe('DecisionReport', () => {
  it('builds a frozen report with its six keys, risks sorted and unique', () => {
    const report = createDecisionReport({
      ...DECISION,
      risks: ['supabase.policy-write', 'supabase.migration-write', 'supabase.policy-write'],
      mission_id: 'mis_1',
    } as DecisionReportInput);
    expect(report).toEqual(DECISION);
    expect(Object.keys(report ?? {})).toEqual([...DECISION_REPORT_KEYS]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report?.risks)).toBe(true);
  });

  it('carries every refusal code of the execution door, and not the wrong-door one', () => {
    expect(DECISION_OUTCOMES).toContain('allowed');
    expect(DECISION_OUTCOMES).toContain('budget-exhausted');
    expect(DECISION_OUTCOMES).not.toContain('wrong-credential-kind');
  });

  it('accepts a null tool, for a name the plugin does not declare', () => {
    expect(createDecisionReport({ ...DECISION, tool: null })?.tool).toBeNull();
  });

  it.each([
    ['risk with its environment label', { risks: ['supabase[prod].migration-write'] }],
    ['risk of another provider', { risks: ['github.git-push'] }],
    ['risk that is a pattern', { risks: ['supabase.*'] }],
    ['risk that is free text', { risks: ['drop table users'] }],
    ['unknown decision', { decision: 'maybe' }],
    ['wrong-door decision', { decision: 'wrong-credential-kind' }],
    ['unknown gate', { gate: 'confirm' }],
    ['tool carrying an argument', { tool: 'supabase__execute_sql?q=1' }],
    ['too many risks', { risks: Array.from({ length: 33 }, (_, i) => `supabase.r${i}`) }],
    ['risks that are not a list', { risks: 'supabase.read-data' }],
  ])('refuses a %s', (_name, override) => {
    expect(createDecisionReport({ ...DECISION, ...override } as DecisionReportInput)).toBeNull();
  });
});

describe('InstanceProfile', () => {
  it('builds a frozen profile with its keys, plugins sorted by id', () => {
    const profile = createInstanceProfile(PROFILE);
    expect(Object.keys(profile ?? {})).toEqual([...INSTANCE_PROFILE_KEYS]);
    expect(profile?.plugins.map((p) => p.plugin)).toEqual(['github', 'supabase']);
    expect(profile?.sign_in_kinds).toEqual(['github', 'oidc']);
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it('drops what a plugin entry smuggles in', () => {
    const profile = createInstanceProfile({
      ...PROFILE,
      plugins: [{ plugin: 'github', plugin_version: '3.0.0', accounts: '1', org: 'acme' } as never],
    });
    expect(profile?.plugins).toEqual([
      { plugin: 'github', plugin_version: '3.0.0', accounts: '1' },
    ]);
  });

  it.each([
    ['instance id that is not 128 bits of hex', { instance_id: 'acme-prod' }],
    ['exact count', { users: '3' }],
    ['unknown deployment', { deployment: 'acme-k8s' }],
    ['runtime with a minor version', { runtime: 'node-22.4.1' }],
    ['unknown architecture', { arch: 'riscv' }],
    ['unknown sign-in kind', { sign_in_kinds: ['saml'] }],
    [
      'plugin listed twice',
      {
        plugins: [
          { plugin: 'github', plugin_version: '3.0.0', accounts: '1' },
          { plugin: 'github', plugin_version: '3.0.0', accounts: '1' },
        ],
      },
    ],
    [
      'plugin with a free-text version',
      { plugins: [{ plugin: 'github', plugin_version: 'main', accounts: '1' }] },
    ],
  ])('refuses a %s', (_name, override) => {
    expect(createInstanceProfile({ ...PROFILE, ...override })).toBeNull();
  });

  it('never sends a count, only its bucket', () => {
    expect([0, 1, 2, 5, 6, 20, 21, 100, 101, 1000, 1001].map(countBucket)).toEqual([
      '0',
      '1',
      '2-5',
      '2-5',
      '6-20',
      '6-20',
      '21-100',
      '21-100',
      '101-1000',
      '101-1000',
      '>1000',
    ]);
    expect(countBucket(-3)).toBe('0');
    expect(countBucket(2.5)).toBe('0');
  });
});
