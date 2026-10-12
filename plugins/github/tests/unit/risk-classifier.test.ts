/**
 * Unit tests for `classifyGithubV4` (Phase 1).
 *
 * These tests pin the (tool, args) → Slice[] contract. They cover :
 *  - happy paths for the common reads / writes
 *  - argument variants (branch / file path / PR base) that change the slice
 *  - the multi-slice tools (`create_pull_request`, `merge_pull_request`,
 *    `create_release`, `push_files`)
 *  - the `workflow-via-file` virtual slice
 *  - retired tools (spec v4 §7.2 #1) — they must return `{ denied: ... }`
 *  - structural denials (unbound repo, missing args, unknown tool)
 *
 * The test does NOT exercise the matcher or the catalog ; that's the
 * `risk-catalog.test.ts` job. Here we only verify the classifier emits the
 * exact slice strings expected by the catalog patterns.
 */

import { describe, expect, test } from 'vitest';
import type { ProviderBinding } from '@vaubaan/shared';
import { serializeSlice } from '@vaubaan/policy-engine';

import { classifyGithubV4 } from '../../src/risk-classifier.ts';

// ─── fixtures ──────────────────────────────────────────────────────────────

const repoRef = 'sbw-vaubaan/gateway';

const githubBinding: ProviderBinding = {
  id: 'pb-1',
  project_id: 'prj-1',
  provider: 'github',
  resource_ref: repoRef,
  display_name: null,
  environment: null,
  created_at: '2026-01-01T00:00:00Z',
};

const bindings: readonly ProviderBinding[] = [githubBinding];

const baseArgs = { owner: 'sbw-vaubaan', repo: 'gateway' };

// ─── helpers ───────────────────────────────────────────────────────────────

function expectSlices(result: ReturnType<typeof classifyGithubV4>): string[] {
  if ('denied' in result) {
    throw new Error(`expected slices, got denied: ${result.denied}`);
  }
  return result.slices.map(serializeSlice);
}

function expectDenied(result: ReturnType<typeof classifyGithubV4>): string {
  if (!('denied' in result)) {
    throw new Error(`expected denied, got slices: ${result.slices.map(serializeSlice).join(', ')}`);
  }
  return result.denied;
}

// ─── reads ─────────────────────────────────────────────────────────────────

describe('classifyGithubV4 — reads', () => {
  test('list_branches → branch.R (bare-name read = "list all")', () => {
    const r = classifyGithubV4('github__list_branches', baseArgs, bindings);
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch.R`]);
  });

  test('get_file_contents (with ref) → branch[ref].file[path].R', () => {
    const r = classifyGithubV4(
      'github__get_file_contents',
      { ...baseArgs, path: 'src/foo.ts', ref: 'main' },
      bindings,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch[main].file[src/foo.ts].R`]);
  });

  test('get_file_contents (no ref) → bare-name branch', () => {
    const r = classifyGithubV4(
      'github__get_file_contents',
      { ...baseArgs, path: 'README.md' },
      bindings,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch.file[README.md].R`]);
  });

  test('search_code (global, no binding lookup) → search.code.R', () => {
    const r = classifyGithubV4('github__search_code', { q: 'foo' }, bindings);
    expect(expectSlices(r)).toEqual(['github.search.code.R']);
  });

  test('search_issues → search.issues.R', () => {
    const r = classifyGithubV4('github__search_issues', { q: 'foo' }, bindings);
    expect(expectSlices(r)).toEqual(['github.search.issues.R']);
  });

  test('list_workflow_runs (with workflow_id) → workflow[id].workflow-run.R', () => {
    const r = classifyGithubV4(
      'github__list_workflow_runs',
      { ...baseArgs, workflow_id: 'ci.yml' },
      bindings,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].workflow[ci.yml].workflow-run.R`]);
  });

  test('get_branch_protection → branch-protection[branch].R', () => {
    const r = classifyGithubV4(
      'github__get_branch_protection',
      { ...baseArgs, branch: 'main' },
      bindings,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch-protection[main].R`]);
  });
});

// ─── writes — branches / files ─────────────────────────────────────────────

describe('classifyGithubV4 — branch / file writes', () => {
  test('create_branch on feature/* → branch[feature/x].W', () => {
    const r = classifyGithubV4(
      'github__create_branch',
      { ...baseArgs, branch: 'feature/auth-bug' },
      bindings,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch[feature/auth-bug].W`]);
  });

  test('create_or_update_file on feature/* → branch[…].file[path].W (no workflow marker)', () => {
    const r = classifyGithubV4(
      'github__create_or_update_file',
      {
        ...baseArgs,
        branch: 'feature/x',
        path: 'src/foo.ts',
        content: 'export const x = 1;',
        message: 'add x',
      },
      bindings,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].branch[feature/x].file[src/foo.ts].W`,
    ]);
  });

  test('create_or_update_file on .github/workflows/*.yml → also emits workflow-via-file', () => {
    const r = classifyGithubV4(
      'github__create_or_update_file',
      {
        ...baseArgs,
        branch: 'feature/ci-tweak',
        path: '.github/workflows/ci.yml',
        content: 'name: ci\n…',
        message: 'tweak CI',
      },
      bindings,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].branch[feature/ci-tweak].file[.github/workflows/ci.yml].W`,
      `github.repo[${repoRef}].branch[feature/ci-tweak].workflow-via-file.W`,
    ]);
  });

  test('create_or_update_file on main → branch[main].file[…].W (matches merge-protected via catalog)', () => {
    const r = classifyGithubV4(
      'github__create_or_update_file',
      {
        ...baseArgs,
        branch: 'main',
        path: 'README.md',
        content: '...',
        message: 'fix readme',
      },
      bindings,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch[main].file[README.md].W`]);
  });

  test('push_files (3 files on feature/*) → per-file + files-bulk marker', () => {
    const r = classifyGithubV4(
      'github__push_files',
      {
        ...baseArgs,
        branch: 'feature/x',
        message: 'add things',
        files: [
          { path: 'a.ts', content: '1' },
          { path: 'b.ts', content: '2' },
          { path: 'c.ts', content: '3' },
        ],
      },
      bindings,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].branch[feature/x].file[a.ts].W`,
      `github.repo[${repoRef}].branch[feature/x].file[b.ts].W`,
      `github.repo[${repoRef}].branch[feature/x].file[c.ts].W`,
      `github.repo[${repoRef}].branch[feature/x].files-bulk.W`,
    ]);
  });

  test('push_files (1 file) → no files-bulk marker', () => {
    const r = classifyGithubV4(
      'github__push_files',
      {
        ...baseArgs,
        branch: 'feature/x',
        message: 'one file',
        files: [{ path: 'a.ts', content: '1' }],
      },
      bindings,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch[feature/x].file[a.ts].W`]);
  });

  test('delete_file on main → branch[main].file[…].W', () => {
    const r = classifyGithubV4(
      'github__delete_file',
      {
        ...baseArgs,
        branch: 'main',
        path: 'src/legacy.ts',
        message: 'rm legacy',
        sha: 'deadbeef',
      },
      bindings,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch[main].file[src/legacy.ts].W`]);
  });
});

// ─── writes — PRs / comments / releases ───────────────────────────────────

describe('classifyGithubV4 — PRs, comments, releases', () => {
  test('create_pull_request → pull_request.W + branch[head].propose-to[base].W', () => {
    const r = classifyGithubV4(
      'github__create_pull_request',
      { ...baseArgs, title: 't', head: 'feature/x', base: 'main' },
      bindings,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].pull_request.W`,
      `github.repo[${repoRef}].branch[feature/x].propose-to[main].W`,
    ]);
  });

  test('merge_pull_request → pull_request[N].W + branch[base].merge-into.W', () => {
    const r = classifyGithubV4(
      'github__merge_pull_request',
      { ...baseArgs, pull_number: 42, base: 'main' },
      bindings,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].pull_request[42].W`,
      `github.repo[${repoRef}].branch[main].merge-into.W`,
    ]);
  });

  test('merge_pull_request without base → defaults to main', () => {
    const r = classifyGithubV4(
      'github__merge_pull_request',
      { ...baseArgs, pull_number: 7 },
      bindings,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].pull_request[7].W`,
      `github.repo[${repoRef}].branch[main].merge-into.W`,
    ]);
  });

  test('add_issue_comment → issue[N].comment.W', () => {
    const r = classifyGithubV4(
      'github__add_issue_comment',
      { ...baseArgs, issue_number: 142, body: 'lgtm' },
      bindings,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].issue[142].comment.W`]);
  });

  test('create_release → release.W + tag[name].W', () => {
    const r = classifyGithubV4(
      'github__create_release',
      { ...baseArgs, tag_name: 'v1.2.3', name: 'v1.2.3' },
      bindings,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].release.W`,
      `github.repo[${repoRef}].tag[v1.2.3].W`,
    ]);
  });

  test('delete_release → release[id].W', () => {
    const r = classifyGithubV4(
      'github__delete_release',
      { ...baseArgs, release_id: 9001 },
      bindings,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].release[9001].W`]);
  });
});

// ─── writes — rules / mint ─────────────────────────────────────────────────

describe('classifyGithubV4 — rules / mint', () => {
  test('update_branch_protection → branch-protection[branch].W', () => {
    const r = classifyGithubV4(
      'github__update_branch_protection',
      { ...baseArgs, branch: 'main', required_status_checks: { strict: true, contexts: [] } },
      bindings,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch-protection[main].W`]);
  });

  test('mint_install_token clone (with repoFullName) → install-token[clone].W', () => {
    const r = classifyGithubV4(
      'github__mint_install_token',
      { purpose: 'clone', repoFullName: repoRef },
      bindings,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].install-token[clone].W`]);
  });

  test('mint_install_token push (no repoFullName) → fan-out over bound repos', () => {
    const second: ProviderBinding = {
      ...githubBinding,
      id: 'pb-2',
      resource_ref: 'sbw-vaubaan/other',
    };
    const r = classifyGithubV4('github__mint_install_token', { purpose: 'push' }, [
      githubBinding,
      second,
    ]);
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].install-token[push].W`,
      'github.repo[sbw-vaubaan/other].install-token[push].W',
    ]);
  });

  test('mint_install_token rejects invalid purpose', () => {
    const r = classifyGithubV4('github__mint_install_token', { purpose: 'delete' }, bindings);
    expect(expectDenied(r)).toContain("requires purpose 'clone' or 'push'");
  });
});

// ─── retired tools (spec v4 §7.2 #1) ───────────────────────────────────────

describe('classifyGithubV4 — retired tools (spec v4 §7.2 #1)', () => {
  test.each([
    ['github__dispatch_workflow', { ...baseArgs, workflow_id: 'ci.yml', ref: 'main' }],
    ['github__cancel_workflow_run', { ...baseArgs, run_id: 1 }],
    ['github__rerun_workflow_run', { ...baseArgs, run_id: 1 }],
  ])('%s returns denied', (tool, args) => {
    const r = classifyGithubV4(tool, args, bindings);
    expect(expectDenied(r)).toBe(
      'tool removed in v4 risk-based model — use cloud-provider tool directly',
    );
  });
});

// ─── structural denials ────────────────────────────────────────────────────

describe('classifyGithubV4 — structural denials', () => {
  test('unknown tool', () => {
    const r = classifyGithubV4('github__moonshot', baseArgs, bindings);
    expect(expectDenied(r)).toContain('unknown github tool');
  });

  test('unbound repo', () => {
    const r = classifyGithubV4(
      'github__list_branches',
      { owner: 'someone-else', repo: 'private' },
      bindings,
    );
    expect(expectDenied(r)).toContain('is not bound to this project');
  });

  test('missing owner/repo', () => {
    const r = classifyGithubV4('github__list_branches', {}, bindings);
    expect(expectDenied(r)).toContain("'owner' and 'repo'");
  });

  test('create_or_update_file missing branch', () => {
    const r = classifyGithubV4(
      'github__create_or_update_file',
      { ...baseArgs, path: 'a.ts', content: '', message: 'm' },
      bindings,
    );
    expect(expectDenied(r)).toContain("'branch' and 'path'");
  });
});
