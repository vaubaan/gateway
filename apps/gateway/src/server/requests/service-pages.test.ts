import { githubPlugin } from '@vaubaan/plugin-github';
import { PluginRegistry } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { servicePagesOf } from './service-pages';

const registry = new PluginRegistry([githubPlugin]);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('servicePagesOf', () => {
  it("links GitHub's comparison of each pushed ref of a waiting push", () => {
    expect(
      servicePagesOf(registry, 'github__git_push', {
        repository: 'acme/app',
        updates: [
          {
            ref: 'refs/heads/feature/x',
            old: A,
            new: B,
            kind: 'force',
            commits: 1,
            files: [],
            workflow_files: [],
          },
          {
            ref: 'refs/heads/gone',
            old: A,
            new: null,
            kind: 'delete',
            commits: 0,
            files: [],
            workflow_files: [],
          },
        ],
      }),
    ).toEqual([
      { label: 'refs/heads/feature/x', url: `https://github.com/acme/app/compare/${A}...${B}` },
    ]);
  });

  it('gives nothing for another tool, erased arguments or malformed ones', () => {
    expect(servicePagesOf(registry, 'github__create_branch', { repository: 'acme/app' })).toEqual(
      [],
    );
    expect(servicePagesOf(registry, 'github__git_push', null)).toEqual([]);
    expect(
      servicePagesOf(registry, 'github__git_push', { repository: 'acme/app', updates: [{}] }),
    ).toEqual([]);
    expect(servicePagesOf(registry, 'nope', {})).toEqual([]);
  });
});
