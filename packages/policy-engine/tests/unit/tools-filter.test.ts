import { describe, expect, test } from 'vitest';
import type { Capability, EnvResolution, McpToolDeclaration } from '@vaubaan/shared';
import {
  filterAvailableTools,
  isToolPotentiallyCallable,
  type ToolSurfaceProvider,
} from '../../src/tools-filter.ts';

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

// Reads are env-static (no branch arg) ; write-PR + merge resolve env from
// `args.head` / `args.base` at call time.
const ENV_RESOLUTION: Record<string, EnvResolution> = {
  github__list_branches: 'static',
  github__get_file_contents: 'static',
  github__create_pull_request: 'runtime',
  github__merge_pull_request: 'runtime',
};

const provider: ToolSurfaceProvider = {
  availableTools: tools,
  toolCapabilities: (t) => SURFACE[t] ?? [],
  toolEnvResolution: (t) => ENV_RESOLUTION[t] ?? 'static',
};

describe('filterAvailableTools', () => {
  test('lists tools whose surface is covered by the granted set (reads are env-static)', () => {
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

  test('env-runtime writes accept any env-qualified grant on the right 4-tuple', () => {
    // Granting code:write @feature/x surfaces the env-runtime write tools
    // (PR creation, merge) — env defensive check fires at call time.
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

  test('env-static read with env-qualified grant → hidden (fix #1 lockstep)', () => {
    // The runtime requires an env-less grant for an env-less read. An @main
    // grant must NOT surface env-static reads — otherwise tools/call would
    // 403 after tools/list listed them.
    const granted: Capability[] = [
      { provider: 'github', plane: 'repo', level: 'code', action: 'read', env: 'main' },
    ];
    const names = filterAvailableTools(granted, provider).map((t) => t.name);
    expect(names).not.toContain('github__list_branches');
    expect(names).not.toContain('github__get_file_contents');
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

describe('isToolPotentiallyCallable — direct predicate', () => {
  const surface: Capability[] = [
    { provider: 'vercel', plane: 'runtime', level: 'deployment', action: 'read' },
  ];

  test('static: env-less grant covers env-less surface', () => {
    const granted: Capability[] = [
      { provider: 'vercel', plane: 'runtime', level: 'deployment', action: 'read' },
    ];
    expect(isToolPotentiallyCallable(granted, surface, 'static')).toBe(true);
  });

  test('static: @prod grant does NOT cover env-less surface (the catalog bug)', () => {
    const granted: Capability[] = [
      { provider: 'vercel', plane: 'runtime', level: 'deployment', action: 'read', env: 'prod' },
    ];
    expect(isToolPotentiallyCallable(granted, surface, 'static')).toBe(false);
  });

  test('runtime: @prod grant DOES cover env-less surface (env-defensive at call time)', () => {
    const granted: Capability[] = [
      { provider: 'vercel', plane: 'runtime', level: 'deployment', action: 'read', env: 'prod' },
    ];
    expect(isToolPotentiallyCallable(granted, surface, 'runtime')).toBe(true);
  });
});
