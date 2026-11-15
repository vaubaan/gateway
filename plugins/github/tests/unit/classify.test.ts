/**
 * Unit tests for `classifyGithub` — the classifier's security suite.
 *
 * These tests pin the (tool, args) → Slice[] contract. They cover :
 *  - happy paths for the common reads / writes
 *  - argument variants (branch / file path / PR base) that change the slice
 *  - the multi-slice tools (`create_pull_request`, `merge_pull_request`,
 *    `create_release`, `push_files`)
 *  - the `workflow-via-file` virtual slice
 *  - retired tools (risk-model spec §7.2 #1) — they must return `{ denied: ... }`
 *  - structural denials (repo outside the mission, missing args, unknown tool,
 *    non-canonical paths, refs given as branches, malformed `files`)
 *
 * The test does NOT exercise the matcher or the catalog : which risks a
 * call touches is pinned in `risk-catalog.test.ts`. Here we only verify the
 * classifier emits the exact slice strings, or the exact refusal.
 */

import { describe, expect, test } from 'vitest';
import { serializeSlice, type ClassifyOutcome, type Resource } from '@vaubaan/plugin-sdk';

import { classifyGithub } from '../../src/classify.ts';

// ─── fixtures ──────────────────────────────────────────────────────────────

const repoRef = 'sbw-vaubaan/gateway';

const githubRepo: Resource = {
  service: 'github',
  ref: repoRef,
  displayName: repoRef,
};

const resources: readonly Resource[] = [githubRepo];

const baseArgs = { owner: 'sbw-vaubaan', repo: 'gateway' };

// ─── helpers ───────────────────────────────────────────────────────────────

function expectSlices(result: ClassifyOutcome): string[] {
  if ('denied' in result) {
    throw new Error(`expected slices, got denied: ${result.denied}`);
  }
  return result.slices.map(serializeSlice);
}

function expectDenied(result: ClassifyOutcome): string {
  if (!('denied' in result)) {
    throw new Error(`expected denied, got slices: ${result.slices.map(serializeSlice).join(', ')}`);
  }
  return result.denied;
}

// ─── reads ─────────────────────────────────────────────────────────────────

describe('classifyGithub — reads', () => {
  test('list_branches → branch.R (bare-name read = "list all")', () => {
    const r = classifyGithub('github__list_branches', baseArgs, resources);
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch.R`]);
  });

  test('get_file_contents (with ref) → branch[ref].file[path].R', () => {
    const r = classifyGithub(
      'github__get_file_contents',
      { ...baseArgs, path: 'src/foo.ts', ref: 'main' },
      resources,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch[main].file[src/foo.ts].R`]);
  });

  test('get_file_contents (no ref) → bare-name branch', () => {
    const r = classifyGithub(
      'github__get_file_contents',
      { ...baseArgs, path: 'README.md' },
      resources,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch.file[README.md].R`]);
  });

  test('search_code (global, no resource lookup) → search.code.R', () => {
    const r = classifyGithub('github__search_code', { q: 'foo' }, resources);
    expect(expectSlices(r)).toEqual(['github.search.code.R']);
  });

  test('search_issues → search.issues.R', () => {
    const r = classifyGithub('github__search_issues', { q: 'foo' }, resources);
    expect(expectSlices(r)).toEqual(['github.search.issues.R']);
  });

  test('list_workflow_runs (with workflow_id) → workflow[id].workflow-run.R', () => {
    const r = classifyGithub(
      'github__list_workflow_runs',
      { ...baseArgs, workflow_id: 'ci.yml' },
      resources,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].workflow[ci.yml].workflow-run.R`]);
  });

  test('get_branch_protection → branch-protection[branch].R', () => {
    const r = classifyGithub(
      'github__get_branch_protection',
      { ...baseArgs, branch: 'main' },
      resources,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch-protection[main].R`]);
  });
});

// ─── writes — branches / files ─────────────────────────────────────────────

describe('classifyGithub — branch / file writes', () => {
  test('create_branch on feature/* → branch[feature/x].W', () => {
    const r = classifyGithub(
      'github__create_branch',
      { ...baseArgs, branch: 'feature/auth-bug' },
      resources,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch[feature/auth-bug].W`]);
  });

  test('create_or_update_file on feature/* → branch[…].file[path].W (no workflow marker)', () => {
    const r = classifyGithub(
      'github__create_or_update_file',
      {
        ...baseArgs,
        branch: 'feature/x',
        path: 'src/foo.ts',
        content: 'export const x = 1;',
        message: 'add x',
      },
      resources,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].branch[feature/x].file[src/foo.ts].W`,
    ]);
  });

  test('create_or_update_file on .github/workflows/*.yml → also emits workflow-via-file', () => {
    const r = classifyGithub(
      'github__create_or_update_file',
      {
        ...baseArgs,
        branch: 'feature/ci-tweak',
        path: '.github/workflows/ci.yml',
        content: 'name: ci\n…',
        message: 'tweak CI',
      },
      resources,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].branch[feature/ci-tweak].file[.github/workflows/ci.yml].W`,
      `github.repo[${repoRef}].branch[feature/ci-tweak].workflow-via-file.W`,
    ]);
  });

  test('create_or_update_file on main → branch[main].file[…].W (matches merge-protected via catalog)', () => {
    const r = classifyGithub(
      'github__create_or_update_file',
      {
        ...baseArgs,
        branch: 'main',
        path: 'README.md',
        content: '...',
        message: 'fix readme',
      },
      resources,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch[main].file[README.md].W`]);
  });

  test('push_files (3 files on feature/*) → per-file + files-bulk marker', () => {
    const r = classifyGithub(
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
      resources,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].branch[feature/x].file[a.ts].W`,
      `github.repo[${repoRef}].branch[feature/x].file[b.ts].W`,
      `github.repo[${repoRef}].branch[feature/x].file[c.ts].W`,
      `github.repo[${repoRef}].branch[feature/x].files-bulk.W`,
    ]);
  });

  test('push_files (1 file) → no files-bulk marker', () => {
    const r = classifyGithub(
      'github__push_files',
      {
        ...baseArgs,
        branch: 'feature/x',
        message: 'one file',
        files: [{ path: 'a.ts', content: '1' }],
      },
      resources,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch[feature/x].file[a.ts].W`]);
  });

  test('delete_file on main → branch[main].file[…].W', () => {
    const r = classifyGithub(
      'github__delete_file',
      {
        ...baseArgs,
        branch: 'main',
        path: 'src/old.ts',
        message: 'rm old',
        sha: 'deadbeef',
      },
      resources,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch[main].file[src/old.ts].W`]);
  });
});

// ─── non-canonical paths, branches and file lists ──────────────────────────

describe('classifyGithub — refuses what it cannot place exactly', () => {
  const NON_CANONICAL_PATHS = [
    '/.github/workflows/ci.yml',
    './.github/workflows/ci.yml',
    '.github//workflows/ci.yml',
    '.github/./workflows/ci.yml',
    'src/../.github/workflows/ci.yml',
    '.github\\workflows\\ci.yml',
    '.github/workflows/ci.yml/',
  ];

  test.each(NON_CANONICAL_PATHS)('create_or_update_file refuses the path %j', (path) => {
    const r = classifyGithub(
      'github__create_or_update_file',
      { ...baseArgs, branch: 'feature/x', path, content: 'x', message: 'm' },
      resources,
    );
    expect(expectDenied(r)).toBe(
      `tool 'github__create_or_update_file' path '${path}' must be relative, with no empty, '.' or '..' segment and no backslash`,
    );
  });

  test.each(NON_CANONICAL_PATHS)('delete_file refuses the path %j', (path) => {
    const r = classifyGithub(
      'github__delete_file',
      { ...baseArgs, branch: 'feature/x', path, message: 'm', sha: 'd' },
      resources,
    );
    expect(expectDenied(r)).toContain(`path '${path}' must be relative`);
  });

  test.each(NON_CANONICAL_PATHS)('push_files refuses an entry with the path %j', (path) => {
    const r = classifyGithub(
      'github__push_files',
      {
        ...baseArgs,
        branch: 'feature/x',
        message: 'm',
        files: [
          { path: 'a.ts', content: '1' },
          { path, content: 'x' },
        ],
      },
      resources,
    );
    expect(expectDenied(r)).toContain(`path '${path}' must be relative`);
  });

  test('a workflow file in a canonical path keeps its marker whatever the case', () => {
    const r = classifyGithub(
      'github__delete_file',
      { ...baseArgs, branch: 'feature/x', path: '.GitHub/Workflows/CI.YAML', message: 'm' },
      resources,
    );
    expect(expectSlices(r)).toContain(
      `github.repo[${repoRef}].branch[feature/x].workflow-via-file.W`,
    );
  });

  test.each([
    ['not an array', { path: 'a.ts', content: '1' }],
    ['an entry without path', [{ path: 'a.ts', content: '1' }, { content: '2' }]],
    [
      'an entry with a non-string path',
      [
        { path: 'a.ts', content: '1' },
        { path: 5, content: '2' },
      ],
    ],
    ['an entry without content', [{ path: 'a.ts', content: '1' }, { path: 'b.ts' }]],
    ['an entry that is not an object', [{ path: 'a.ts', content: '1' }, 'b.ts']],
    ['an empty array', []],
  ])('push_files refuses files that are %s', (_label, files) => {
    const r = classifyGithub(
      'github__push_files',
      { ...baseArgs, branch: 'feature/x', message: 'm', files },
      resources,
    );
    expect(expectDenied(r)).toBe(
      "tool 'github__push_files' requires 'files' to be a non-empty array of { path, content } strings",
    );
  });

  test.each([
    ['github__create_branch', { branch: 'refs/heads/main' }],
    [
      'github__create_or_update_file',
      { branch: 'refs/heads/main', path: 'a.ts', content: 'x', message: 'm' },
    ],
    ['github__delete_file', { branch: 'refs/heads/main', path: 'a.ts', message: 'm', sha: 'd' }],
    [
      'github__push_files',
      { branch: 'refs/heads/main', message: 'm', files: [{ path: 'a.ts', content: '1' }] },
    ],
    ['github__update_branch_protection', { branch: 'heads/main' }],
  ])('%s refuses a ref where a branch name is expected', (tool, args) => {
    const r = classifyGithub(tool, { ...baseArgs, ...args }, resources);
    expect(expectDenied(r)).toContain("must be a branch name such as 'main', not a ref");
  });

  test('wildcard characters never reach a slice identifier', () => {
    // No branch holds a `*` (git refuses it) : the call is refused, not rewritten.
    for (const branch of ['*', 'feature/**']) {
      const r = classifyGithub('github__create_branch', { ...baseArgs, branch }, resources);
      expect(expectDenied(r)).toBe(
        `tool 'github__create_branch' branch '${branch}' is not a branch name`,
      );
    }
    // In a file path `*` is an ordinary character, which the slice grammar cannot
    // carry : the file is "any", never a glob and never a repaired name.
    const file = classifyGithub(
      'github__create_or_update_file',
      { ...baseArgs, branch: 'feature/x', path: 'src/*.ts', content: 'x', message: 'm' },
      resources,
    );
    expect(expectSlices(file)).toEqual([`github.repo[${repoRef}].branch[feature/x].file[*].W`]);
  });
});

// ─── writes — PRs / comments / releases ───────────────────────────────────

describe('classifyGithub — PRs, comments, releases', () => {
  test('create_pull_request → pull_request.W + branch[head].propose-to[base].W', () => {
    const r = classifyGithub(
      'github__create_pull_request',
      { ...baseArgs, title: 't', head: 'feature/x', base: 'main' },
      resources,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].pull_request.W`,
      `github.repo[${repoRef}].branch[feature/x].propose-to[main].W`,
    ]);
  });

  test('merge_pull_request → pull_request[N].W + branch[base].merge-into.W', () => {
    const r = classifyGithub(
      'github__merge_pull_request',
      { ...baseArgs, pull_number: 42, base: 'main' },
      resources,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].pull_request[42].W`,
      `github.repo[${repoRef}].branch[main].merge-into.W`,
    ]);
  });

  test('merge_pull_request without base → defaults to main', () => {
    const r = classifyGithub(
      'github__merge_pull_request',
      { ...baseArgs, pull_number: 7 },
      resources,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].pull_request[7].W`,
      `github.repo[${repoRef}].branch[main].merge-into.W`,
    ]);
  });

  test('add_issue_comment → issue[N].comment.W', () => {
    const r = classifyGithub(
      'github__add_issue_comment',
      { ...baseArgs, issue_number: 142, body: 'lgtm' },
      resources,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].issue[142].comment.W`]);
  });

  test('add_labels → one issue[N].label[<name>].W per label, trimmed, deduplicated', () => {
    const r = classifyGithub(
      'github__add_labels',
      { ...baseArgs, issue_number: 142, labels: [' e2e ', 'bug', 'e2e'] },
      resources,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].issue[142].label[e2e].W`,
      `github.repo[${repoRef}].issue[142].label[bug].W`,
    ]);
  });

  test('add_labels : a name the slice grammar cannot carry is "any", never repaired', () => {
    const r = classifyGithub(
      'github__add_labels',
      { ...baseArgs, issue_number: 3, labels: ['good first issue'] },
      resources,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].issue[3].label[*].W`]);
  });

  test.each([
    ['no labels', undefined],
    ['an empty list (GitHub would remove every label)', []],
    ['a string, not a list', 'e2e'],
    ['a blank name', ['e2e', '  ']],
    ['a name over 50 characters', ['x'.repeat(51)]],
    ['a multi-line name', ['a\nb']],
    ['a name that is not a string', [7]],
    ['21 names', Array.from({ length: 21 }, (_, i) => `l${i}`)],
  ])('add_labels refuses %s', (_label, labels) => {
    const r = classifyGithub(
      'github__add_labels',
      { ...baseArgs, issue_number: 1, labels },
      resources,
    );
    expect(r).toHaveProperty('denied');
  });

  test('create_release → release.W + tag[name].W', () => {
    const r = classifyGithub(
      'github__create_release',
      { ...baseArgs, tag_name: 'v1.2.3', name: 'v1.2.3' },
      resources,
    );
    expect(expectSlices(r)).toEqual([
      `github.repo[${repoRef}].release.W`,
      `github.repo[${repoRef}].tag[v1.2.3].W`,
    ]);
  });

  test('delete_release → release[id].delete.W', () => {
    const r = classifyGithub(
      'github__delete_release',
      { ...baseArgs, release_id: 9001 },
      resources,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].release[9001].delete.W`]);
  });
});

// ─── writes — rules ────────────────────────────────────────────────────────

describe('classifyGithub — rules', () => {
  test('update_branch_protection → branch-protection[branch].W', () => {
    const r = classifyGithub(
      'github__update_branch_protection',
      { ...baseArgs, branch: 'main', required_status_checks: { strict: true, contexts: [] } },
      resources,
    );
    expect(expectSlices(r)).toEqual([`github.repo[${repoRef}].branch-protection[main].W`]);
  });
});

// ─── retired tools (risk-model spec §7.2 #1) ───────────────────────────────────────

describe('classifyGithub — retired tools (risk-model spec §7.2 #1)', () => {
  test.each([
    ['github__dispatch_workflow', { ...baseArgs, workflow_id: 'ci.yml', ref: 'main' }],
    ['github__cancel_workflow_run', { ...baseArgs, run_id: 1 }],
    ['github__rerun_workflow_run', { ...baseArgs, run_id: 1 }],
  ])('%s returns denied', (tool, args) => {
    const r = classifyGithub(tool, args, resources);
    expect(expectDenied(r)).toBe(
      'tool retired: this gateway does not dispatch, cancel or re-run GitHub workflows — use the deployment tools of the service that hosts the service.',
    );
  });
});

// ─── structural denials ────────────────────────────────────────────────────

describe('classifyGithub — structural denials', () => {
  test('unknown tool', () => {
    const r = classifyGithub('github__moonshot', baseArgs, resources);
    expect(expectDenied(r)).toContain('unknown github tool');
  });

  test('repo outside the mission', () => {
    const r = classifyGithub(
      'github__list_branches',
      { owner: 'someone-else', repo: 'private' },
      resources,
    );
    expect(expectDenied(r)).toBe(
      "github repository 'someone-else/private' is not selected in this mission. Selected: sbw-vaubaan/gateway.",
    );
  });

  test('repo outside a mission of many repositories : the refusal gives their count, not their names', () => {
    const many: Resource[] = Array.from({ length: 6 }, (_, i) => ({
      service: 'github',
      ref: `sbw-vaubaan/repo-${i}`,
      displayName: `sbw-vaubaan/repo-${i}`,
    }));
    const r = classifyGithub('github__list_branches', { owner: 'someone-else', repo: 'x' }, many);
    expect(expectDenied(r)).toBe(
      "github repository 'someone-else/x' is not selected in this mission. 6 repositories are selected.",
    );
    const five = classifyGithub(
      'github__list_branches',
      { owner: 'someone-else', repo: 'x' },
      many.slice(0, 5),
    );
    expect(expectDenied(five)).toContain(
      'Selected: sbw-vaubaan/repo-0, sbw-vaubaan/repo-1, sbw-vaubaan/repo-2, sbw-vaubaan/repo-3, sbw-vaubaan/repo-4.',
    );
  });

  test('repo-scoped tool in a mission without GitHub repository', () => {
    const otherService: Resource = { service: 'vercel', ref: 'prj_1', displayName: 'web' };
    for (const missionResources of [[], [otherService]]) {
      const r = classifyGithub('github__list_branches', baseArgs, missionResources);
      expect(expectDenied(r)).toBe('no GitHub repository is selected in this mission.');
    }
  });

  test('missing owner/repo', () => {
    const r = classifyGithub('github__list_branches', {}, resources);
    expect(expectDenied(r)).toContain("'owner' and 'repo'");
  });

  test('create_or_update_file missing branch', () => {
    const r = classifyGithub(
      'github__create_or_update_file',
      { ...baseArgs, path: 'a.ts', content: '', message: 'm' },
      resources,
    );
    expect(expectDenied(r)).toContain("'branch' and 'path'");
  });
});

// ─── identifiers the slice grammar cannot carry ───────────────────────────────

/**
 * A name git and GitHub accept may hold characters the slice grammar has no
 * place for (`ü`, `+`, a space, `*` in a path, `:` in a fork head). It is
 * written as "any" (`[*]`), never repaired into another name : `feature/ü`
 * is not `feature/-`. The risks "any branch" touches are pinned in
 * `risk-catalog.test.ts`.
 */
describe('classifyGithub — identifiers the slice grammar cannot carry are "any"', () => {
  const repo = `github.repo[${repoRef}]`;

  test.each(['feature/ü', 'feature/a+b', 'release-ü'])(
    'create_branch %s → branch[*].W, not a repaired name',
    (branch) => {
      const r = classifyGithub('github__create_branch', { ...baseArgs, branch }, resources);
      expect(expectSlices(r)).toEqual([`${repo}.branch[*].W`]);
    },
  );

  test('a file path with a space or a star → file[*], on its branch', () => {
    for (const path of ['docs/my notes.md', 'src/a*.ts']) {
      const r = classifyGithub(
        'github__create_or_update_file',
        { ...baseArgs, branch: 'feature/x', path, content: '', message: 'm' },
        resources,
      );
      expect(expectSlices(r)).toEqual([`${repo}.branch[feature/x].file[*].W`]);
    }
  });

  test('a fork head owner:branch → branch[*].propose-to[base]', () => {
    const r = classifyGithub(
      'github__create_pull_request',
      { ...baseArgs, title: 't', head: 'someone:feature/x', base: 'main' },
      resources,
    );
    expect(expectSlices(r)).toEqual([
      `${repo}.pull_request.W`,
      `${repo}.branch[*].propose-to[main].W`,
    ]);
  });

  test('a git push to such a branch → branch[*] slices', () => {
    const r = classifyGithub(
      'github__git_push',
      {
        repository: repoRef,
        updates: [
          {
            ref: 'refs/heads/feature/ü',
            old: null,
            new: 'b'.repeat(40),
            kind: 'create',
            commits: 1,
            files: ['a.ts'],
            workflow_files: [],
          },
        ],
      },
      resources,
    );
    expect(expectSlices(r)).toEqual([`${repo}.branch[*].push.W`, `${repo}.branch[*].W`]);
  });
});
