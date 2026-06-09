import { describe, expect, test } from 'vitest';
import type { Capability, McpToolDeclaration } from '@vaubaan/shared';
import { filterAvailableTools, type ToolSurfaceProvider } from '../../src/tools-filter.ts';

const tools: McpToolDeclaration[] = [
  { name: 'github__list_branches', description: '', inputSchema: { type: 'object' } },
  { name: 'github__get_file_contents', description: '', inputSchema: { type: 'object' } },
  { name: 'github__create_pull_request', description: '', inputSchema: { type: 'object' } },
  { name: 'github__merge_pull_request', description: '', inputSchema: { type: 'object' } },
];

// Minimal surface map mirroring the github classifier (env-less surface).
const SURFACE: Record<string, Capability[]> = {
  github__list_branches: [{ provider: 'github', plane: 'repo', level: 'code', action: 'read' }],
  github__get_file_contents: [{ provider: 'github', plane: 'repo', level: 'code', action: 'read' }],
  github__create_pull_request: [
    { provider: 'github', plane: 'repo', level: 'code', action: 'write' },
  ],
  github__merge_pull_request: [
    { provider: 'github', plane: 'repo', level: 'code', action: 'write' },
  ],
};

const provider: ToolSurfaceProvider = {
  availableTools: tools,
  toolCapabilities: (t) => SURFACE[t] ?? [],
};

describe('filterAvailableTools', () => {
  test('lists tools whose surface is covered by the granted set (env ignored)', () => {
    const granted: Capability[] = [
      { provider: 'github', plane: 'repo', level: 'code', action: 'read' },
    ];
    const names = filterAvailableTools(granted, provider).map((t) => t.name);
    expect(names).toContain('github__list_branches');
    expect(names).toContain('github__get_file_contents');
    // write not granted → write tools hidden
    expect(names).not.toContain('github__create_pull_request');
    expect(names).not.toContain('github__merge_pull_request');
  });

  test('static filter ignores env on the grant', () => {
    // Granting code:write @feature/x is enough to surface ALL write tools at
    // list time — env enforcement happens at call time, not at list time.
    const granted: Capability[] = [
      { provider: 'github', plane: 'repo', level: 'code', action: 'write', env: 'feature/x' },
      { provider: 'github', plane: 'repo', level: 'code', action: 'read' },
    ];
    const names = filterAvailableTools(granted, provider).map((t) => t.name);
    expect(names).toEqual([
      'github__list_branches',
      'github__get_file_contents',
      'github__create_pull_request',
      'github__merge_pull_request',
    ]);
  });

  test('different provider does not surface', () => {
    const granted: Capability[] = [
      { provider: 'gitlab', plane: 'repo', level: 'code', action: 'read' },
    ];
    expect(filterAvailableTools(granted, provider)).toEqual([]);
  });

  test('empty grant → empty', () => {
    expect(filterAvailableTools([], provider)).toEqual([]);
  });
});
