import { describe, expect, test } from 'vitest';
import type { ProviderBinding, Role } from '@vaubaan/shared';
import { evaluatePolicy } from '../../src/evaluate.ts';

function role(
  name: string,
  provider: 'github' | 'vercel' | 'supabase',
  rules: Role['permissions']['rules'],
): Role {
  return {
    id: name,
    organization_id: null,
    provider,
    name,
    description: null,
    is_builtin: true,
    permissions: { version: 1, rules },
    created_at: '2026-01-01T00:00:00Z',
  };
}

const ghBinding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'github',
  resource_ref: 'acme/app',
  display_name: null,
  created_at: '2026-01-01T00:00:00Z',
};

describe('evaluatePolicy — default deny', () => {
  test('no rule → denied', () => {
    const r = role('github:empty', 'github', [{ effect: 'allow', tool: 'github__list_repos' }]);
    const result = evaluatePolicy([r], [ghBinding], {
      provider: 'github',
      tool: 'github__delete_repo',
      arguments: { owner: 'acme', repo: 'app' },
    });
    expect(result.decision).toBe('denied');
  });

  test('no role for provider → denied with explicit reason', () => {
    const r = role('github:reader', 'github', [{ effect: 'allow', tool: 'github__list' }]);
    const result = evaluatePolicy([r], [], {
      provider: 'vercel',
      tool: 'vercel__list_projects',
      arguments: {},
    });
    expect(result.decision).toBe('denied');
    if (result.decision === 'denied') expect(result.reason).toMatch(/vercel/);
  });
});

describe('evaluatePolicy — allow', () => {
  test('allow with target match', () => {
    const r = role('github:reader', 'github', [
      { effect: 'allow', target: 'project.repos', tool_matches: ['github__list_*'] },
    ]);
    const result = evaluatePolicy([r], [ghBinding], {
      provider: 'github',
      tool: 'github__list_pulls',
      arguments: { owner: 'acme', repo: 'app' },
    });
    expect(result.decision).toBe('allowed');
    if (result.decision === 'allowed') expect(result.roleMatched).toBe('github:reader');
  });

  test('allow with wildcard target', () => {
    const r = role('github:wildcard', 'github', [
      { effect: 'allow', target: '*', tool: 'github__get_user' },
    ]);
    const result = evaluatePolicy([r], [], {
      provider: 'github',
      tool: 'github__get_user',
      arguments: {},
    });
    expect(result.decision).toBe('allowed');
  });

  test('allow with constraint match', () => {
    const r = role('github:developer', 'github', [
      {
        effect: 'allow',
        target: 'project.repos',
        tool: 'github__create_pull_request',
        constraints: {
          'arguments.head': { match: ['feature/*'] },
          'arguments.base': { equals: 'main' },
        },
      },
    ]);
    const result = evaluatePolicy([r], [ghBinding], {
      provider: 'github',
      tool: 'github__create_pull_request',
      arguments: { owner: 'acme', repo: 'app', head: 'feature/foo', base: 'main' },
    });
    expect(result.decision).toBe('allowed');
  });

  test('constraint mismatch on allow → denied with actionable reason', () => {
    const r = role('github:developer', 'github', [
      {
        effect: 'allow',
        target: 'project.repos',
        tool: 'github__push_files',
        constraints: {
          'arguments.branch': { match: ['feature/*', 'fix/*', 'claude/*'] },
        },
      },
    ]);
    const result = evaluatePolicy([r], [ghBinding], {
      provider: 'github',
      tool: 'github__push_files',
      arguments: { owner: 'acme', repo: 'app', branch: 'main' },
    });
    expect(result.decision).toBe('denied');
    if (result.decision === 'denied') {
      expect(result.reason).toMatch(/branch/);
      expect(result.reason).toMatch(/main/);
      expect(result.reason).toMatch(/feature\/\*/);
      expect(result.reason).toMatch(/Suggestion/);
    }
  });
});

describe('evaluatePolicy — deny override allow', () => {
  test('deny wins when both match', () => {
    const r = role('github:mixed', 'github', [
      { effect: 'allow', target: '*', tool: 'github__delete_repo' },
      { effect: 'deny', tool_matches: ['github__delete_*'] },
    ]);
    const result = evaluatePolicy([r], [ghBinding], {
      provider: 'github',
      tool: 'github__delete_repo',
      arguments: { owner: 'acme', repo: 'app' },
    });
    expect(result.decision).toBe('denied');
  });

  test('priority tie-break on deny', () => {
    const r1 = role('github:r1', 'github', [
      { effect: 'deny', tool: 'github__merge_pr', priority: 50 },
    ]);
    const r2 = role('github:r2', 'github', [
      { effect: 'deny', tool: 'github__merge_pr', priority: 200 },
    ]);
    const result = evaluatePolicy([r1, r2], [], {
      provider: 'github',
      tool: 'github__merge_pr',
      arguments: {},
    });
    expect(result.decision).toBe('denied');
    if (result.decision === 'denied') expect(result.ruleSource).toBe('github:r2');
  });
});

describe('evaluatePolicy — target resolution', () => {
  test('target.repos not matching args → denied (default deny)', () => {
    const r = role('github:reader', 'github', [
      { effect: 'allow', target: 'project.repos', tool_matches: ['github__list_*'] },
    ]);
    const result = evaluatePolicy([r], [ghBinding], {
      provider: 'github',
      tool: 'github__list_pulls',
      arguments: { owner: 'other', repo: 'app' },
    });
    expect(result.decision).toBe('denied');
  });

  test('missing owner/repo args → denied', () => {
    const r = role('github:reader', 'github', [
      { effect: 'allow', target: 'project.repos', tool_matches: ['github__list_*'] },
    ]);
    const result = evaluatePolicy([r], [ghBinding], {
      provider: 'github',
      tool: 'github__list_pulls',
      arguments: {},
    });
    expect(result.decision).toBe('denied');
  });
});

describe('evaluatePolicy — first allow wins between two allows', () => {
  test('order is stable', () => {
    const r = role('github:multi', 'github', [
      { effect: 'allow', target: '*', tool: 'github__list_repos' },
      { effect: 'allow', target: '*', tool: 'github__list_repos' },
    ]);
    const result = evaluatePolicy([r], [], {
      provider: 'github',
      tool: 'github__list_repos',
      arguments: {},
    });
    expect(result.decision).toBe('allowed');
  });
});

describe('evaluatePolicy — provider filtering', () => {
  test('roles of other provider are ignored', () => {
    const gh = role('github:reader', 'github', [
      { effect: 'allow', target: '*', tool_matches: ['*'] },
    ]);
    const result = evaluatePolicy([gh], [], {
      provider: 'vercel',
      tool: 'vercel__list_projects',
      arguments: {},
    });
    expect(result.decision).toBe('denied');
  });
});
