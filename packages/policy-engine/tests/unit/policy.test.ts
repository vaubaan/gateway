import { describe, expect, test } from 'vitest';
import type { Capability } from '@vaubaan/shared';
import {
  allCapsAiAllowed,
  evaluatePolicy,
  humanGatedDecisions,
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
  test('no rule → default-deny (human)', () => {
    const d = evaluatePolicy([cap('github', 'repo', 'code', 'read')], []);
    expect(d[0]!.gate).toBe('human');
    expect(d[0]!.matchedRule).toBeNull();
  });

  test('seed rule (*,*,*,read,*) ai-allows reads', () => {
    const rules = [rule({ action: 'read', gate: 'ai', priority: 0 })];
    const d = evaluatePolicy([cap('github', 'repo', 'code', 'read')], rules);
    expect(d[0]!.gate).toBe('ai');
  });

  test('seed rule (*,*,*,write,*,human) blocks writes by default', () => {
    const rules = [rule({ action: 'write', gate: 'human', priority: 0 })];
    const d = evaluatePolicy([cap('github', 'repo', 'code', 'write', 'main')], rules);
    expect(d[0]!.gate).toBe('human');
  });

  test('more specific rule wins over blanket', () => {
    const rules = [
      rule({ action: 'write', gate: 'human', priority: 0 }, 'blanket'),
      rule(
        {
          provider: 'github',
          plane: 'repo',
          level: 'code',
          action: 'write',
          env_pattern: 'feature/x',
          gate: 'ai',
        },
        'specific',
      ),
    ];
    const d = evaluatePolicy([cap('github', 'repo', 'code', 'write', 'feature/x')], rules);
    expect(d[0]!.gate).toBe('ai');
    expect(d[0]!.matchedRule?.id).toBe('specific');
  });

  test('same specificity → priority desc wins', () => {
    const rules = [
      rule({ action: 'read', gate: 'human', priority: 50 }, 'lower-pri'),
      rule({ action: 'read', gate: 'ai', priority: 200 }, 'higher-pri'),
    ];
    const d = evaluatePolicy([cap('github', 'repo', 'code', 'read')], rules);
    expect(d[0]!.matchedRule?.id).toBe('higher-pri');
    expect(d[0]!.gate).toBe('ai');
  });

  test('env-less cap only matches env_pattern=*', () => {
    const rules = [
      rule({ action: 'write', env_pattern: 'main', gate: 'ai' }, 'specific-env'),
      rule({ action: 'write', env_pattern: '*', gate: 'human' }, 'blanket'),
    ];
    // env-less write : doesn't match 'main' rule → falls back to '*' rule.
    const d = evaluatePolicy([cap('vercel', 'runtime', 'config', 'write')], rules);
    expect(d[0]!.matchedRule?.id).toBe('blanket');
    expect(d[0]!.gate).toBe('human');
  });

  test('@prod requirement requires a @prod or @* rule', () => {
    const rules = [
      rule(
        {
          provider: 'vercel',
          plane: 'runtime',
          level: 'deployment',
          action: 'write',
          env_pattern: 'prod',
          gate: 'human',
        },
        'prod-rule',
      ),
    ];
    const d = evaluatePolicy([cap('vercel', 'runtime', 'deployment', 'write', 'prod')], rules);
    expect(d[0]!.matchedRule?.id).toBe('prod-rule');
    expect(d[0]!.gate).toBe('human');
  });

  test('a different env does not match a specific env rule', () => {
    const rules = [rule({ action: 'write', env_pattern: 'prod', gate: 'ai' })];
    const d = evaluatePolicy([cap('vercel', 'runtime', 'deployment', 'write', 'staging')], rules);
    // No matching rule → default-deny.
    expect(d[0]!.gate).toBe('human');
  });
});

describe('allCapsAiAllowed / humanGatedDecisions', () => {
  test('all ai → true', () => {
    const rules = [rule({ action: 'read', gate: 'ai', priority: 0 })];
    const d = evaluatePolicy(
      [cap('github', 'repo', 'code', 'read'), cap('vercel', 'runtime', 'deployment', 'read')],
      rules,
    );
    expect(allCapsAiAllowed(d)).toBe(true);
    expect(humanGatedDecisions(d)).toEqual([]);
  });

  test('mixed → false + lists human-gated', () => {
    const rules = [
      rule({ action: 'read', gate: 'ai', priority: 0 }),
      rule({ action: 'write', gate: 'human', priority: 0 }),
    ];
    const d = evaluatePolicy(
      [
        cap('github', 'repo', 'code', 'read'),
        cap('vercel', 'runtime', 'deployment', 'write', 'prod'),
      ],
      rules,
    );
    expect(allCapsAiAllowed(d)).toBe(false);
    const gated = humanGatedDecisions(d);
    expect(gated).toHaveLength(1);
    expect(gated[0]!.capability.action).toBe('write');
  });
});
