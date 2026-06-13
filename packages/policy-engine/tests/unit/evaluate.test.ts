import { describe, expect, test } from 'vitest';
import type { Capability } from '@vaubaan/shared';
import { evaluateCapability } from '../../src/evaluate.ts';

function cap(
  provider: string,
  plane: string,
  level: string,
  action: 'read' | 'write',
  env?: string,
): Capability {
  return env ? { provider, plane, level, action, env } : { provider, plane, level, action };
}

describe('evaluateCapability', () => {
  test('exact tuple match → allowed', () => {
    const granted = [cap('github', 'repo', 'code', 'read')];
    const d = evaluateCapability(granted, cap('github', 'repo', 'code', 'read'));
    expect(d.decision).toBe('allowed');
    expect(d.capabilityMatched).toBe('github:code:read');
  });

  test('missing capability → denied with actionable reason', () => {
    const granted = [cap('github', 'repo', 'code', 'read')];
    const d = evaluateCapability(granted, cap('github', 'repo', 'code', 'write', 'main'));
    expect(d.decision).toBe('denied');
    expect(d.reason).toContain('github:code:write@main');
  });

  test('env defensive filter: @prod required, only @staging granted → denied', () => {
    const granted = [cap('vercel', 'runtime', 'deployment', 'write', 'staging')];
    const d = evaluateCapability(granted, cap('vercel', 'runtime', 'deployment', 'write', 'prod'));
    expect(d.decision).toBe('denied');
  });

  test('env-less grant fans out to @prod (spec §5.1 #3)', () => {
    const granted = [cap('vercel', 'runtime', 'deployment', 'write')];
    const d = evaluateCapability(granted, cap('vercel', 'runtime', 'deployment', 'write', 'prod'));
    expect(d.decision).toBe('allowed');
    expect(d.capabilityMatched).toBe('vercel:deployment:write@prod');
  });

  test('env-less grant + excludeEnvs → fan-out denied on excluded env (spec §5.1 #4)', () => {
    const granted = [cap('github', 'repo', 'code', 'write')];
    const d = evaluateCapability(granted, cap('github', 'repo', 'code', 'write', 'main'), {
      excludeEnvs: ['main'],
    });
    expect(d.decision).toBe('denied');
  });

  test('env match → allowed, capability_matched carries env', () => {
    const granted = [cap('vercel', 'runtime', 'deployment', 'write', 'prod')];
    const d = evaluateCapability(granted, cap('vercel', 'runtime', 'deployment', 'write', 'prod'));
    expect(d.decision).toBe('allowed');
    expect(d.capabilityMatched).toBe('vercel:deployment:write@prod');
  });

  test('level distinction: config:write not covered by deployment:write', () => {
    const granted = [cap('vercel', 'runtime', 'deployment', 'write', 'prod')];
    const d = evaluateCapability(granted, cap('vercel', 'runtime', 'config', 'write', 'prod'));
    expect(d.decision).toBe('denied');
  });

  test('provider distinction: different provider does not cover', () => {
    const granted = [cap('github', 'repo', 'code', 'read')];
    const d = evaluateCapability(granted, cap('gitlab', 'repo', 'code', 'read'));
    expect(d.decision).toBe('denied');
  });

  test('empty grant → denied with (none)', () => {
    const d = evaluateCapability([], cap('github', 'repo', 'code', 'read'));
    expect(d.decision).toBe('denied');
    expect(d.reason).toContain('(none)');
  });
});
