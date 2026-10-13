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

import { prepareCatalog, risksTouchedByAll } from '@vaubaan/policy-engine';
import type { Resource } from '@vaubaan/plugin-sdk';

import { classifyGithub } from '../../src/classify.ts';
import { githubCatalog, githubPlugin } from '../../src/index.ts';
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
  ['get_branch_protection', 'of main', { ...repo, branch: 'main' }, ['read-meta']],
  ['search_code', 'account-wide', { q: 'foo' }, ['search-global']],
  ['search_issues', 'account-wide', { q: 'foo' }, ['search-global']],
];

const BRANCH_AND_FILE_WRITES: readonly Row[] = [
  ['create_branch', 'feature/*', { ...repo, branch: 'feature/x' }, ['feature-branch-write']],
  ['create_branch', 'fix/*', { ...repo, branch: 'fix/x' }, ['feature-branch-write']],
  ['create_branch', 'release-*', { ...repo, branch: 'release-2026' }, ['merge-protected']],
  ['create_branch', 'unconventional name', { ...repo, branch: 'wip-x' }, [FALLBACK]],

  ['create_or_update_file', 'feature/*', file('feature/x'), ['feature-branch-write']],
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
  // Publishing and deleting are two risks with two patterns : neither requires the other.
  ['create_release', 'release and tag', { ...repo, tag_name: 'v1.0.0' }, ['create-release']],
  ['delete_release', 'one', { ...repo, release_id: 1 }, ['delete-release']],
  ['update_branch_protection', 'of main', { ...repo, branch: 'main' }, ['branch-protection-write']],
  [
    'mint_install_token',
    'clone, one repository',
    { purpose: 'clone', repoFullName: 'acme/app' },
    ['mint-install-token-clone'],
  ],
  ['mint_install_token', 'clone, fan-out', { purpose: 'clone' }, ['mint-install-token-clone']],
  [
    'mint_install_token',
    'push, one repository',
    { purpose: 'push', repoFullName: 'acme/lib' },
    ['mint-install-token-push'],
  ],
  ['mint_install_token', 'push, fan-out', { purpose: 'push' }, ['mint-install-token-push']],
];

const ROWS: readonly Row[] = [...READS, ...BRANCH_AND_FILE_WRITES, ...OTHER_WRITES];

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

  test('every declared tool has a row', () => {
    const covered = new Set(ROWS.map(([tool]) => `github__${tool}`));
    expect(githubPlugin.tools.map((t) => t.name).filter((name) => !covered.has(name))).toEqual([]);
  });

  test('the rows name every risk of the catalog, and only risks of the catalog', () => {
    const expected = new Set(ROWS.flatMap(([, , , risks]) => risks));
    const catalogIds = githubCatalog.catalog.risks.map((r) => r.id.slice(ID_PREFIX.length));
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
