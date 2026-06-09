import { describe, expect, test } from 'vitest';
import type { Capability } from '@vaubaan/shared';
import {
  allCapsAllowed,
  confirmDecisions,
  denyDecisions,
  evaluatePolicy,
  type PolicyRule,
} from '../../src/policy.ts';

const cap = (
  provider: string,
  plane: string,
  level: string,
  action: 'read' | 'write',
  env?: string,
): Capability =>
  env ? { provider, plane, level, action, env } : { provider, plane, level, action };

const rule = (
  partial: Partial<PolicyRule> & Pick<PolicyRule, 'gate'>,
  id = `r-${Math.random().toString(36).slice(2, 6)}`,
): PolicyRule => ({
  id,
  project_id: 'p1',
  provider: '*',
  plane: '*',
  level: '*',
  action: '*',
  env_pattern: '*',
  priority: 100,
  ...partial,
});

describe('evaluatePolicy', () => {
  test('no rule → default-deny', () => {
    const d = evaluatePolicy([cap('github', 'repo', 'code', 'read')], []);
    expect(d[0]!.gate).toBe('deny');
    expect(d[0]!.matchedRule).toBeNull();
  });

  test('seed rule (*,*,*,read,*) → allow', () => {
    const rules = [rule({ action: 'read', gate: 'allow', priority: 0 })];
    const d = evaluatePolicy([cap('github', 'repo', 'code', 'read')], rules);
    expect(d[0]!.gate).toBe('allow');
  });

  test('seed rule (*,*,*,write,*) → confirm', () => {
    const rules = [rule({ action: 'write', gate: 'confirm', priority: 0 })];
    const d = evaluatePolicy([cap('github', 'repo', 'code', 'write', 'main')], rules);
    expect(d[0]!.gate).toBe('confirm');
  });

  test('explicit deny on a specific cap → deny', () => {
    const rules = [
      rule({ action: 'write', gate: 'confirm', priority: 0 }, 'seed'),
      rule(
        {
          provider: 'github',
          plane: 'repo',
          level: 'access',
          action: 'write',
          gate: 'deny',
        },
        'deny-access',
      ),
    ];
    const d = evaluatePolicy([cap('github', 'repo', 'access', 'write')], rules);
    expect(d[0]!.gate).toBe('deny');
    expect(d[0]!.matchedRule?.id).toBe('deny-access');
  });

  test('more specific rule wins over blanket', () => {
    const rules = [
      rule({ action: 'write', gate: 'confirm', priority: 0 }, 'blanket'),
      rule(
        {
          provider: 'github',
          plane: 'repo',
          level: 'code',
          action: 'write',
          env_pattern: 'feature/x',
          gate: 'allow',
        },
        'specific',
      ),
    ];
    const d = evaluatePolicy([cap('github', 'repo', 'code', 'write', 'feature/x')], rules);
    expect(d[0]!.gate).toBe('allow');
    expect(d[0]!.matchedRule?.id).toBe('specific');
  });

  test('same specificity → priority desc wins', () => {
    const rules = [
      rule({ action: 'read', gate: 'confirm', priority: 50 }, 'lower-pri'),
      rule({ action: 'read', gate: 'allow', priority: 200 }, 'higher-pri'),
    ];
    const d = evaluatePolicy([cap('github', 'repo', 'code', 'read')], rules);
    expect(d[0]!.matchedRule?.id).toBe('higher-pri');
    expect(d[0]!.gate).toBe('allow');
  });

  test('env-less cap only matches env_pattern=*', () => {
    const rules = [
      rule({ action: 'write', env_pattern: 'main', gate: 'allow' }, 'specific-env'),
      rule({ action: 'write', env_pattern: '*', gate: 'confirm' }, 'blanket'),
    ];
    const d = evaluatePolicy([cap('vercel', 'runtime', 'config', 'write')], rules);
    expect(d[0]!.matchedRule?.id).toBe('blanket');
    expect(d[0]!.gate).toBe('confirm');
  });

  test('@prod requires a @prod or @* rule', () => {
    const rules = [
      rule(
        {
          provider: 'vercel',
          plane: 'runtime',
          level: 'deployment',
          action: 'write',
          env_pattern: 'prod',
          gate: 'confirm',
        },
        'prod-rule',
      ),
    ];
    const d = evaluatePolicy([cap('vercel', 'runtime', 'deployment', 'write', 'prod')], rules);
    expect(d[0]!.matchedRule?.id).toBe('prod-rule');
    expect(d[0]!.gate).toBe('confirm');
  });

  test('a different env does not match a specific env rule → default-deny', () => {
    const rules = [rule({ action: 'write', env_pattern: 'prod', gate: 'allow' })];
    const d = evaluatePolicy([cap('vercel', 'runtime', 'deployment', 'write', 'staging')], rules);
    expect(d[0]!.gate).toBe('deny');
  });
});

describe('allCapsAllowed / confirmDecisions / denyDecisions', () => {
  test('all allow → true', () => {
    const rules = [rule({ action: 'read', gate: 'allow', priority: 0 })];
    const d = evaluatePolicy(
      [cap('github', 'repo', 'code', 'read'), cap('vercel', 'runtime', 'deployment', 'read')],
      rules,
    );
    expect(allCapsAllowed(d)).toBe(true);
    expect(confirmDecisions(d)).toEqual([]);
    expect(denyDecisions(d)).toEqual([]);
  });

  test('mixed allow + confirm', () => {
    const rules = [
      rule({ action: 'read', gate: 'allow', priority: 0 }),
      rule({ action: 'write', gate: 'confirm', priority: 0 }),
    ];
    const d = evaluatePolicy(
      [
        cap('github', 'repo', 'code', 'read'),
        cap('vercel', 'runtime', 'deployment', 'write', 'prod'),
      ],
      rules,
    );
    expect(allCapsAllowed(d)).toBe(false);
    expect(confirmDecisions(d)).toHaveLength(1);
    expect(denyDecisions(d)).toEqual([]);
  });

  test('any deny → denyDecisions non-empty', () => {
    const rules = [
      rule({ action: 'read', gate: 'allow', priority: 0 }),
      rule(
        {
          provider: 'github',
          plane: 'repo',
          level: 'access',
          action: 'write',
          gate: 'deny',
        },
        'deny-access',
      ),
    ];
    const d = evaluatePolicy(
      [cap('github', 'repo', 'code', 'read'), cap('github', 'repo', 'access', 'write')],
      rules,
    );
    expect(denyDecisions(d)).toHaveLength(1);
    expect(denyDecisions(d)[0]!.capability.level).toBe('access');
  });
});
