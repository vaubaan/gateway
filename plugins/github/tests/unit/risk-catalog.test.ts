/**
 * Tool → risk binding of the github plugin : each row runs `classifyGithub`
 * and matches the emitted slices against the shipped catalog, then pins the
 * exact set of risks the call touches. `classify.test.ts` stops at the slice
 * strings ; this file is what fails when a catalog pattern or a classifier
 * branch moves a call to another risk.
 *
 * Every declared tool has at least one row (asserted at the end). Risk ids
 * are written without their `github.` prefix.
 */
import { describe, expect, test } from 'vitest';

import { prepareCatalog, risksTouchedByAll } from '@vaubaan/plugin-sdk/testing';

import type { Resource } from '@vaubaan/plugin-sdk';

import { classifyGithub } from '../../src/classify.ts';
import { githubCatalog, githubPlugin, workingBranchesOf } from '../../src/index.ts';
import { appRepo, libRepo } from './fixtures.ts';

const repo = { owner: 'acme', repo: 'app' };
const WORKFLOW = '.github/workflows/ci.yml';
const FALLBACK = 'uncategorized-write';

const file = (branch: string, path = 'src/a.ts') => ({
  ...repo,
  branch,
  path,
  content: 'x',
  message: 'm',
});
const push = (branch: string, ...paths: string[]) => ({
  ...repo,
  branch,
  message: 'm',
  files: paths.map((path) => ({ path, content: 'x' })),
});

type Row = readonly [
  tool: string,
  label: string,
  args: Readonly<Record<string, unknown>>,
  risks: readonly string[],
];

const READS: readonly Row[] = [
  ['list_branches', 'all branches', repo, ['read-code']],
  ['list_commits', 'default branch', repo, ['read-code']],
  ['list_commits', 'of a branch', { ...repo, sha: 'feature/x' }, ['read-code']],
  ['get_file_contents', 'default branch', { ...repo, path: 'README.md' }, ['read-code']],
  ['get_file_contents', 'on main', { ...repo, path: 'src/a.ts', ref: 'main' }, ['read-code']],
  ['get_file_contents', 'a workflow file', { ...repo, path: WORKFLOW }, ['read-code']],
  ['get_commit', 'one commit', { ...repo, sha: 'deadbeef' }, ['read-code']],
  ['list_tags', 'all tags', repo, ['read-code']],
  ['list_pull_requests', 'open', { ...repo, state: 'open' }, ['read-meta']],
  ['get_pull_request', 'one', { ...repo, pull_number: 1 }, ['read-meta']],
  ['list_issues', 'all', repo, ['read-meta']],
  ['get_issue', 'one', { ...repo, issue_number: 1 }, ['read-meta']],
  ['list_releases', 'all', repo, ['read-meta']],
  ['list_workflows', 'all', repo, ['read-meta']],
  ['list_workflow_runs', 'of the repository', repo, ['read-meta']],
  ['list_workflow_runs', 'of a workflow', { ...repo, workflow_id: 'ci.yml' }, ['read-meta']],
  ['list_workflow_jobs', 'of a run', { ...repo, run_id: 7 }, ['read-meta']],
  ['get_job_logs', 'of a job', { ...repo, job_id: 9, tail: true }, ['read-meta']],
  ['get_branch_protection', 'of main', { ...repo, branch: 'main' }, ['read-meta']],
  ['search_code', 'account-wide', { q: 'foo' }, ['search-global']],
  ['search_issues', 'account-wide', { q: 'foo' }, ['search-global']],
];

const BRANCH_AND_FILE_WRITES: readonly Row[] = [
  ['create_branch', 'feature/*', { ...repo, branch: 'feature/x' }, ['feature-branch-write']],
  ['create_branch', 'fix/*', { ...repo, branch: 'fix/x' }, ['feature-branch-write']],
  // `feat/<id>-<slug>` : Conventional Commits, this repository's own convention.
  ['create_branch', 'feat/*', { ...repo, branch: 'feat/x' }, ['feature-branch-write']],
  ['create_branch', 'release-*', { ...repo, branch: 'release-2026' }, ['merge-protected']],
  ['create_branch', 'unconventional name', { ...repo, branch: 'wip-x' }, [FALLBACK]],
  // A name the slice grammar cannot carry is "any" (`branch[*]`), whatever its
  // prefix : it touches what any branch may, the working AND the protected
  // branches' risk. Repaired (`feature/-`, `release--`), it touched one of them.
  ...['feature/ü', 'feature/a+b', 'release-ü'].map((branch): Row => [
    'create_branch',
    `${branch}, outside the slice grammar`,
    { ...repo, branch },
    ['feature-branch-write', 'merge-protected'],
  ]),

  ['create_or_update_file', 'feature/*', file('feature/x'), ['feature-branch-write']],
  ['create_or_update_file', 'feat/*', file('feat/x'), ['feature-branch-write']],
  ['create_or_update_file', 'main', file('main'), ['merge-protected']],
  ['create_or_update_file', 'master', file('master'), ['merge-protected']],
  ['create_or_update_file', 'production', file('production'), ['merge-protected']],
  [
    'create_or_update_file',
    'workflow on feature/*',
    file('feature/x', WORKFLOW),
    ['feature-branch-write', 'workflow-write-via-file'],
  ],
  [
    'create_or_update_file',
    'workflow (.yaml) on main',
    file('main', '.github/workflows/release.yaml'),
    ['merge-protected', 'workflow-write-via-file'],
  ],
  [
    'create_or_update_file',
    'not a workflow : nested below workflows/',
    file('feature/x', '.github/workflows/lib/a.yml'),
    ['feature-branch-write'],
  ],
  ['create_or_update_file', 'unconventional branch', file('wip-x'), [FALLBACK]],
  // A path the slice grammar cannot carry is "any" (`file[*]`) : the branch decides.
  [
    'create_or_update_file',
    'a path with a space on feature/*',
    file('feature/x', 'docs/my notes.md'),
    ['feature-branch-write'],
  ],
  [
    'create_or_update_file',
    'workflow on an unconventional branch',
    file('wip-x', WORKFLOW),
    ['workflow-write-via-file', FALLBACK],
  ],

  ['delete_file', 'feature/*', { ...file('feature/x'), sha: 'd' }, ['feature-branch-write']],
  ['delete_file', 'main', { ...file('main'), sha: 'd' }, ['merge-protected']],
  [
    'delete_file',
    'workflow on feature/*',
    { ...file('feature/x', WORKFLOW), sha: 'd' },
    ['feature-branch-write', 'workflow-write-via-file'],
  ],

  ['push_files', 'one file on feature/*', push('feature/x', 'a.ts'), ['feature-branch-write']],
  [
    'push_files',
    'two files on feat/*',
    push('feat/x', 'a.ts', 'b.ts'),
    ['feature-branch-write', 'bulk-file-write'],
  ],
  [
    'push_files',
    'two files on feature/*',
    push('feature/x', 'a.ts', 'b.ts'),
    ['feature-branch-write', 'bulk-file-write'],
  ],
  [
    'push_files',
    'two files on main',
    push('main', 'a.ts', 'b.ts'),
    ['merge-protected', 'bulk-file-write'],
  ],
  [
    'push_files',
    'a workflow among the files',
    push('feature/x', 'a.ts', WORKFLOW),
    ['feature-branch-write', 'workflow-write-via-file', 'bulk-file-write'],
  ],
  [
    'push_files',
    'two files on an unconventional branch',
    push('wip-x', 'a.ts', 'b.ts'),
    ['bulk-file-write', FALLBACK],
  ],
];

const OTHER_WRITES: readonly Row[] = [
  [
    'create_pull_request',
    'feature/* into main',
    { ...repo, title: 't', head: 'feature/x', base: 'main' },
    ['create-pr'],
  ],
  // `pull_request[N].W` is a pattern of `create-pr` : a merge touches it too.
  [
    'merge_pull_request',
    'no declared base (main)',
    { ...repo, pull_number: 1 },
    ['create-pr', 'merge-protected'],
  ],
  [
    'merge_pull_request',
    'into main',
    { ...repo, pull_number: 1, base: 'main' },
    ['create-pr', 'merge-protected'],
  ],
  [
    'merge_pull_request',
    'into release-*',
    { ...repo, pull_number: 1, base: 'release-1' },
    ['create-pr', 'merge-protected'],
  ],
  // No named risk covers a merge into a non-protected branch : fallback.
  [
    'merge_pull_request',
    'into feature/*',
    { ...repo, pull_number: 1, base: 'feature/x' },
    ['create-pr', FALLBACK],
  ],
  ['add_issue_comment', 'on an issue', { ...repo, issue_number: 1, body: 'b' }, ['comment-write']],
  ['add_labels', 'one label', { ...repo, issue_number: 1, labels: ['e2e'] }, ['label-write']],
  // A label is not a comment : neither risk covers the other's slice.
  [
    'add_labels',
    'a name the slice grammar cannot carry',
    { ...repo, issue_number: 1, labels: ['good first issue', 'e2e'] },
    ['label-write'],
  ],
  // Publishing and deleting are two risks with two patterns : neither requires the other.
  ['create_release', 'release and tag', { ...repo, tag_name: 'v1.0.0' }, ['create-release']],
  ['delete_release', 'one', { ...repo, release_id: 1 }, ['delete-release']],
  ['update_branch_protection', 'of main', { ...repo, branch: 'main' }, ['branch-protection-write']],
];

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
type Kind = 'create' | 'fast-forward' | 'force' | 'delete';
const gitUpdate = (ref: string, kind: Kind, files: readonly string[] = ['src/a.ts']) => ({
  ref,
  old: kind === 'create' ? null : OLD,
  new: kind === 'delete' ? null : NEW,
  kind,
  commits: kind === 'delete' ? 0 : 1,
  files: kind === 'delete' ? [] : files,
  workflow_files: files.filter((f) => f.startsWith('.github/workflows/')),
});
const gitPush = (...updates: ReturnType<typeof gitUpdate>[]) => ({
  repository: 'acme/app',
  updates,
});

/** The git remote's two tools (spec §4.1 ter) : never MCP tools, classified the same way. */
const GIT: readonly Row[] = [
  ['git_fetch', 'refs', { repository: 'acme/app', step: 'refs' }, ['read-code']],
  ['git_fetch', 'pack', { repository: 'acme/app', step: 'pack' }, ['read-code']],
  [
    'git_push',
    'new feature branch',
    gitPush(gitUpdate('refs/heads/feature/x', 'create')),
    ['git-push', 'feature-branch-write'],
  ],
  [
    'git_push',
    'fast-forward on a feature branch',
    gitPush(gitUpdate('refs/heads/fix/y', 'fast-forward')),
    ['git-push', 'feature-branch-write'],
  ],
  [
    'git_push',
    'new feat/* branch (refused on the fallback before catalog v7)',
    gitPush(gitUpdate('refs/heads/feat/v5-plugin-context7', 'create')),
    ['git-push', 'feature-branch-write'],
  ],
  [
    'git_push',
    'force on a feature branch',
    gitPush(gitUpdate('refs/heads/feature/x', 'force')),
    ['git-push', 'feature-branch-write', 'force-push'],
  ],
  [
    'git_push',
    'to main',
    gitPush(gitUpdate('refs/heads/main', 'fast-forward')),
    ['git-push', 'merge-protected'],
  ],
  [
    'git_push',
    'unconventional branch',
    gitPush(gitUpdate('refs/heads/wip', 'create')),
    ['git-push', FALLBACK],
  ],
  [
    'git_push',
    'workflow change',
    gitPush(gitUpdate('refs/heads/feature/ci', 'fast-forward', [WORKFLOW])),
    ['git-push', 'feature-branch-write', 'workflow-write-via-file'],
  ],
  [
    'git_push',
    'delete a feature branch',
    gitPush(gitUpdate('refs/heads/feature/old', 'delete')),
    ['git-push', 'feature-branch-write', 'branch-delete'],
  ],
  [
    'git_push',
    'delete main',
    gitPush(gitUpdate('refs/heads/main', 'delete')),
    ['git-push', 'merge-protected', 'branch-delete'],
  ],
  [
    'git_push',
    'new tag',
    gitPush(gitUpdate('refs/tags/v1.2.0', 'create')),
    ['git-push', 'tag-write', 'create-release'],
  ],
  [
    'git_push',
    'moved tag',
    gitPush(gitUpdate('refs/tags/v1.2.0', 'force')),
    ['git-push', 'tag-write', 'create-release', 'force-push'],
  ],
  [
    'git_push',
    'tag with a workflow change',
    gitPush(gitUpdate('refs/tags/v2', 'create', [WORKFLOW])),
    ['git-push', 'tag-write', 'create-release', 'workflow-write-via-file'],
  ],
  [
    'git_push',
    'deleted tag',
    gitPush(gitUpdate('refs/tags/v1.2.0', 'delete')),
    ['git-push', 'tag-write', 'create-release'],
  ],
  [
    'git_push',
    'two refs at once',
    gitPush(gitUpdate('refs/heads/feature/x', 'create'), gitUpdate('refs/heads/main', 'force')),
    ['git-push', 'feature-branch-write', 'merge-protected', 'force-push'],
  ],
];

const ROWS: readonly Row[] = [...READS, ...BRANCH_AND_FILE_WRITES, ...OTHER_WRITES, ...GIT];

const resources: readonly Resource[] = [appRepo, libRepo];
const indexed = prepareCatalog(githubCatalog.catalog, { warn: () => undefined });
const ID_PREFIX = 'github.';

function risksOf(tool: string, args: Readonly<Record<string, unknown>>): string[] {
  const out = classifyGithub(`github__${tool}`, args, resources);
  if ('denied' in out) throw new Error(`expected slices, got denied: ${out.denied}`);
  return risksTouchedByAll(out.slices, indexed).map((id) => {
    if (!id.startsWith(ID_PREFIX)) throw new Error(`risk '${id}' is not a github risk`);
    return id.slice(ID_PREFIX.length);
  });
}

describe('github — the risks each tool touches', () => {
  test.each(ROWS)('%s (%s)', (tool, _label, args, risks) => {
    expect(risksOf(tool, args).sort()).toEqual([...risks].sort());
  });

  test('every declared tool has a row, the two tools of the git remote included', () => {
    const covered = new Set(ROWS.map(([tool]) => `github__${tool}`));
    const declared = [
      ...githubPlugin.tools.map((t) => t.name),
      githubPlugin.gitRemote.fetchTool,
      githubPlugin.gitRemote.pushTool,
    ];
    expect(declared.filter((name) => !covered.has(name))).toEqual([]);
  });

  test('the rows name every risk of the catalog, and only risks of the catalog', () => {
    const expected = new Set(ROWS.flatMap(([, , , risks]) => risks));
    // A deprecated risk is matched by no call : the rows leave it out.
    const catalogIds = githubCatalog.catalog.risks
      .filter((r) => !r.deprecated)
      .map((r) => r.id.slice(ID_PREFIX.length));
    expect(catalogIds.filter((id) => !expected.has(id))).toEqual([]);
    expect([...expected].filter((id) => !catalogIds.includes(id))).toEqual([]);
  });

  test('no read touches a write risk, and no row is left without a risk', () => {
    const readRisks = new Set(['read-code', 'read-meta', 'search-global']);
    for (const [tool, , args] of READS) {
      expect(risksOf(tool, args).filter((id) => !readRisks.has(id))).toEqual([]);
    }
    for (const [tool, , args] of ROWS) expect(risksOf(tool, args)).not.toEqual([]);
  });
});

describe('github — the working branches, one list', () => {
  const WORKING = `${ID_PREFIX}feature-branch-write`;

  test('the three patterns of feature-branch-write name the same branches, feat/* among them', () => {
    const entry = githubCatalog.catalog.risks.find((r) => r.id === WORKING);
    const lists = [entry!.matches].flat().map((p) => /\.branch\[([^\]]+)\]/.exec(p)?.[1]);
    expect(new Set(lists).size).toBe(1);
    expect(workingBranchesOf(githubCatalog.catalog)).toEqual(lists[0]!.split(','));
    expect(workingBranchesOf(githubCatalog.catalog)).toContain('feat/*');
  });

  test("the git remote's words list the catalog's branches, not a copy", () => {
    const ability = githubPlugin.gitRemote.abilities!.find((a) => a.risk_id === WORKING);
    expect(ability!.words).toBe(
      `push to working branches (${workingBranchesOf(githubCatalog.catalog).join(', ')})`,
    );
    expect(ability!.words).toContain('feat/*');
  });

  test('a catalog without the branch-write pattern fails at boot', () => {
    expect(() => workingBranchesOf({ service: 'github', risks: [] })).toThrow(
      /feature-branch-write/,
    );
  });
});
