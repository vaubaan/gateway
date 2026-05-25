import { describe, expect, test } from 'vitest';
import type { McpToolDeclaration, Role } from '@vaubaan/shared';
import { filterAvailableTools } from '../../src/tools-filter.ts';

const tools: McpToolDeclaration[] = [
  { name: 'github__list_repos', description: '', inputSchema: { type: 'object' } },
  { name: 'github__get_file', description: '', inputSchema: { type: 'object' } },
  { name: 'github__create_pull_request', description: '', inputSchema: { type: 'object' } },
  { name: 'github__delete_repo', description: '', inputSchema: { type: 'object' } },
  { name: 'github__merge_pull_request', description: '', inputSchema: { type: 'object' } },
];

const developerRole: Role = {
  id: 'r1',
  organization_id: null,
  provider: 'github',
  name: 'github:developer',
  description: null,
  is_builtin: true,
  created_at: '2026-01-01',
  permissions: {
    version: 1,
    rules: [
      {
        effect: 'allow',
        target: 'project.repos',
        tool_matches: ['github__list_*', 'github__get_*'],
      },
      { effect: 'allow', target: 'project.repos', tool: 'github__create_pull_request' },
      { effect: 'deny', tool_matches: ['github__delete_*', 'github__merge_pull_request'] },
    ],
  },
};

describe('filterAvailableTools', () => {
  test('keeps tools matched by at least one allow rule', () => {
    const out = filterAvailableTools([developerRole], tools);
    const names = out.map((t) => t.name);
    expect(names).toContain('github__list_repos');
    expect(names).toContain('github__get_file');
    expect(names).toContain('github__create_pull_request');
  });

  test('static filter does NOT exclude deny-only tools (constraint of static filter, ok)', () => {
    // tools/list pre-filter is *generous*: it includes tools that at least one
    // allow could touch. deny rules without an opposing allow disappear naturally.
    const out = filterAvailableTools([developerRole], tools);
    const names = out.map((t) => t.name);
    expect(names).not.toContain('github__delete_repo');
    expect(names).not.toContain('github__merge_pull_request');
  });

  test('empty roles → empty', () => {
    expect(filterAvailableTools([], tools)).toEqual([]);
  });
});
