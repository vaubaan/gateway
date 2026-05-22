import { describe, expect, test } from 'vitest';
import { parsePermissions, safeParsePermissions } from '../../src/dsl.ts';

describe('parsePermissions', () => {
  test('valid v1 single allow', () => {
    const p = parsePermissions({
      version: 1,
      rules: [{ effect: 'allow', tool: 'github__list_repos' }],
    });
    expect(p.version).toBe(1);
    expect(p.rules).toHaveLength(1);
  });

  test('rejects version != 1', () => {
    const r = safeParsePermissions({ version: 2, rules: [{ effect: 'allow', tool: 'x' }] });
    expect(r.ok).toBe(false);
  });

  test('rejects rule without tool/tool_matches', () => {
    const r = safeParsePermissions({
      version: 1,
      rules: [{ effect: 'allow', target: 'project.repos' }],
    });
    expect(r.ok).toBe(false);
  });

  test('accepts tool_matches glob', () => {
    const r = safeParsePermissions({
      version: 1,
      rules: [{ effect: 'allow', tool_matches: ['github__list_*', 'github__get_*'] }],
    });
    expect(r.ok).toBe(true);
  });

  test('rejects unknown operator', () => {
    const r = safeParsePermissions({
      version: 1,
      rules: [
        {
          effect: 'allow',
          tool: 'x',
          constraints: { 'arguments.branch': { wat: 'main' } },
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  test('accepts known operators', () => {
    const r = safeParsePermissions({
      version: 1,
      rules: [
        {
          effect: 'allow',
          tool: 'x',
          constraints: {
            'arguments.equals': { equals: 'a' },
            'arguments.in': { in: ['a', 'b'] },
            'arguments.match': { match: ['a/*'] },
            'arguments.regex': { regex: '^x' },
            'arguments.sw': { starts_with: 'feat' },
            'arguments.nsw': { not_starts_with: ['main'] },
            'arguments.notin': { not_in: ['main'] },
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  test('accepts builtin github:developer shape', () => {
    const r = safeParsePermissions({
      version: 1,
      rules: [
        {
          effect: 'allow',
          target: 'project.repos',
          tool_matches: ['github__list_*', 'github__get_*', 'github__search_*'],
        },
        {
          effect: 'allow',
          target: 'project.repos',
          tool_matches: ['github__create_or_update_file', 'github__push_files'],
          constraints: {
            'arguments.branch': { match: ['feature/*', 'fix/*', 'claude/*'] },
          },
        },
        {
          effect: 'allow',
          target: 'project.repos',
          tool: 'github__create_branch',
          constraints: {
            'arguments.branch': { match: ['feature/*', 'fix/*', 'claude/*'] },
          },
        },
        {
          effect: 'allow',
          target: 'project.repos',
          tool: 'github__create_pull_request',
          constraints: {
            'arguments.head': { match: ['feature/*', 'fix/*', 'claude/*'] },
            'arguments.base': { equals: 'main' },
          },
        },
        {
          effect: 'deny',
          tool_matches: ['github__delete_*', 'github__merge_pull_request'],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });
});
