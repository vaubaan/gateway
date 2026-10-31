/**
 * Mandatory structural suite of the github plugin (spec §10) : the SDK kit,
 * catalog coverage of every declared tool, the fallback lint, the
 * macro-actions at their trust levels and the credential spec. The classifier branches are pinned in
 * `classify.test.ts`, the risks each tool touches in `risk-catalog.test.ts`,
 * upstream calls in `execute.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { type Resource } from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  policyFromMacroActions,
} from '@vaubaan/plugin-sdk/testing';

import { classifyGithub, githubCatalog, githubCredential, githubPlugin } from '../../src/index.ts';
import { appRepo, executeCtx, libRepo } from './fixtures.ts';

const repo = { owner: 'acme', repo: 'app' };
const feature = 'feature/test';

/**
 * Realistic calls per tool ; branches are feature/* and protected names, so
 * both write classes are exercised and no sample lands on the fallback.
 */
const samples = {
  github__list_branches: [{ args: { ...repo } }],
  github__list_commits: [{ args: { ...repo } }, { args: { ...repo, sha: feature } }],
  github__list_pull_requests: [{ args: { ...repo, state: 'open' } }],
  github__list_issues: [{ args: { ...repo } }],
  github__get_file_contents: [
    { args: { ...repo, path: 'README.md' } },
    { args: { ...repo, path: 'src/a.ts', ref: 'main' } },
  ],
  github__get_pull_request: [{ args: { ...repo, pull_number: 1 } }],
  github__get_issue: [{ args: { ...repo, issue_number: 1 } }],
  github__get_commit: [{ args: { ...repo, sha: 'deadbeef' } }],
  github__search_code: [{ args: { q: 'foo' } }],
  github__search_issues: [{ args: { q: 'foo' } }],
  github__create_branch: [
    { args: { ...repo, branch: feature } },
    { args: { ...repo, branch: 'release-2026' } },
  ],
  github__create_or_update_file: [
    { args: { ...repo, branch: feature, path: 'src/a.ts', content: 'x', message: 'm' } },
    { args: { ...repo, branch: 'main', path: 'README.md', content: 'x', message: 'm' } },
    {
      args: {
        ...repo,
        branch: feature,
        path: '.github/workflows/ci.yml',
        content: 'x',
        message: 'm',
      },
    },
  ],
  github__push_files: [
    {
      args: {
        ...repo,
        branch: feature,
        message: 'm',
        files: [
          { path: 'a.ts', content: '1' },
          { path: 'b.ts', content: '2' },
        ],
      },
    },
  ],
  github__create_pull_request: [{ args: { ...repo, title: 't', head: feature, base: 'main' } }],
  github__add_issue_comment: [{ args: { ...repo, issue_number: 1, body: 'b' } }],
  github__list_workflows: [{ args: { ...repo } }],
  github__list_workflow_runs: [{ args: { ...repo } }, { args: { ...repo, workflow_id: 'ci.yml' } }],
  github__list_workflow_jobs: [
    { args: { ...repo, run_id: 7 } },
    { args: { ...repo, run_id: 7, filter: 'all' } },
  ],
  github__get_job_logs: [
    { args: { ...repo, job_id: 9 } },
    { args: { ...repo, job_id: 9, max_bytes: 1024, tail: true } },
  ],
  github__get_branch_protection: [{ args: { ...repo, branch: 'main' } }],
  github__merge_pull_request: [
    { args: { ...repo, pull_number: 1 } },
    { args: { ...repo, pull_number: 1, base: 'release-2026' } },
  ],
  github__delete_file: [
    { args: { ...repo, branch: feature, path: 'a.ts', message: 'm', sha: 'd' } },
  ],
  github__update_branch_protection: [{ args: { ...repo, branch: 'main' } }],
  github__list_releases: [{ args: { ...repo } }],
  github__list_tags: [{ args: { ...repo } }],
  github__create_release: [{ args: { ...repo, tag_name: 'v1.0.0' } }],
  github__delete_release: [{ args: { ...repo, release_id: 1 } }],
  // The git remote's two tools : their arguments are the host's review.
  github__git_fetch: [{ args: { repository: 'acme/app', step: 'pack' } }],
  github__git_push: [
    {
      args: {
        repository: 'acme/app',
        updates: [
          gitUpdate('refs/heads/feature/test', 'create'),
          gitUpdate('refs/heads/main', 'force', ['.github/workflows/ci.yml']),
          gitUpdate('refs/heads/feature/old', 'delete'),
          gitUpdate('refs/tags/v1.0.0', 'create'),
        ],
      },
    },
    {
      args: { repository: 'acme/app', updates: [gitUpdate('refs/notes/x', 'create')] },
      expectDenied: true,
    },
  ],
} as const;

function gitUpdate(
  ref: string,
  kind: 'create' | 'force' | 'delete',
  files: readonly string[] = ['a.ts'],
) {
  return {
    ref,
    old: kind === 'create' ? null : 'a'.repeat(40),
    new: kind === 'delete' ? null : 'b'.repeat(40),
    kind,
    commits: kind === 'delete' ? 0 : 1,
    files: kind === 'delete' ? [] : [...files],
    workflow_files: files.filter((f) => f.startsWith('.github/workflows/')),
  };
}

const resources: readonly Resource[] = [appRepo];

describe('github plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(githubPlugin);
    assertNoWildcard(githubPlugin);
  });

  test('27 tools declared, all prefixed', () => {
    expect(githubPlugin.tools).toHaveLength(27);
    for (const t of githubPlugin.tools) expect(t.name.startsWith('github__')).toBe(true);
  });

  test('every tool classifies to slices a named risk covers ; no sample slice lands on the fallback', () => {
    const report = assertCatalogCoverage(githubPlugin, samples, { resources });
    // The 25 MCP tools and the git remote's two.
    expect(report.toolsChecked).toBe(29);
    // The 16 named risks, in catalog order ; the fallback is not among them.
    expect(report.risksTouched).toEqual([
      'github.read-code',
      'github.read-meta',
      'github.search-global',
      'github.feature-branch-write',
      'github.merge-protected',
      'github.workflow-write-via-file',
      'github.bulk-file-write',
      'github.create-pr',
      'github.comment-write',
      'github.create-release',
      'github.delete-release',
      'github.branch-protection-write',
      'github.git-push',
      'github.force-push',
      'github.branch-delete',
      'github.tag-write',
    ]);
    // The two mint risks of the App are deprecated : no call touches them (catalog v9).
    expect(report.risksUntouched).toEqual([
      'github.mint-install-token-clone',
      'github.mint-install-token-push',
    ]);
    expect(report.fallbackHits).toEqual([]);
  });

  // What is executed is what was classified (SDK kit) : every string argument of
  // every sample above is fed the hostile identifiers, through `classify` and
  // through `execute`. The finer cases are in this plugin's identifier tests.
  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(githubPlugin, samples, {
      resources,
      context: (fetch, missionResources) => executeCtx(fetch, missionResources),
    });
    expect(report.toolsChecked).toBe(27);
    // Found by running the samples : the arguments that are a segment of a request path.
    expect([...new Set(report.pathIdentifiers.map((p) => p.argument))].sort()).toEqual([
      'branch',
      'owner',
      'path',
      'repo',
      'sha',
      'workflow_id',
    ]);
    // Whatever classify refused, execute sent nothing for.
    expect(report.refusedByClassify).toBeGreaterThan(0);
    expect(report.nothingSent).toBeGreaterThanOrEqual(report.refusedByClassify);
  });

  test('the fallback is the one catalog risk the samples leave out', () => {
    const named = githubCatalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id);
    expect(named).toHaveLength(18);
    expect(githubCatalog.catalog.risks.filter((r) => r.fallback).map((r) => r.id)).toEqual([
      'github.uncategorized-write',
    ]);
  });

  test('writes outside the branch conventions do land on the fallback, slice by slice', () => {
    const report = assertCatalogCoverage(
      githubPlugin,
      {
        ...samples,
        github__create_or_update_file: [
          { args: { ...repo, branch: 'wip-x', path: 'a.ts', content: '', message: 'm' } },
        ],
        // A merge into a non-protected branch has no named risk of its own.
        github__merge_pull_request: [{ args: { ...repo, pull_number: 1, base: feature } }],
      },
      { resources },
    );
    expect(report.fallbackHits).toEqual([
      "'github__create_or_update_file' sample #1 slice #1",
      "'github__merge_pull_request' sample #1 slice #2",
    ]);
  });
});

describe('github catalog — macro-actions at a trust level', () => {
  const gates = (trustLevels: Parameters<typeof policyFromMacroActions>[1]) =>
    Object.fromEntries(
      policyFromMacroActions(githubPlugin, trustLevels).map((l) => [l.risk_id, l.gate]),
    );

  test('read, propose, ship, administer ; catalog version 11', () => {
    expect(githubCatalog.catalog.macro_actions.map((a) => a.id)).toEqual([
      'read',
      'propose',
      'ship',
      'administer',
    ]);
    expect(githubCatalog.catalog.catalog_version).toBe(11);
  });

  test('read at Prudent : code and metadata run freely, the global search asks first', () => {
    expect(gates({ read: 'prudent' })).toEqual({
      'github.read-code': 'auto',
      'github.read-meta': 'auto',
      'github.search-global': 'approval',
    });
  });

  test('propose at Prudent writes on feature branches and PRs, never on protected branches or admin surfaces', () => {
    const propose = gates({ propose: 'prudent' });
    for (const id of [
      'github.feature-branch-write',
      'github.git-push',
      'github.bulk-file-write',
      'github.create-pr',
      'github.comment-write',
    ]) {
      expect(propose[id], id).toBe('auto');
    }
    // A force-push or a branch deletion is costly : it asks first.
    expect(propose['github.force-push']).toBe('approval');
    expect(propose['github.branch-delete']).toBe('approval');
    for (const id of [
      'github.merge-protected',
      'github.branch-protection-write',
      'github.workflow-write-via-file',
      'github.create-release',
      'github.delete-release',
      'github.tag-write',
    ]) {
      expect(Object.keys(propose)).not.toContain(id);
    }
  });

  test('ship at Confiant : merges, tags and releases ask first ; deleting a release is left out at Prudent', () => {
    expect(gates({ ship: 'confiant' })).toEqual({
      'github.merge-protected': 'approval',
      'github.tag-write': 'approval',
      'github.create-release': 'approval',
      'github.delete-release': 'approval',
    });
    expect(Object.keys(gates({ ship: 'prudent' }))).not.toContain('github.delete-release');
  });

  test('administer : branch protection and workflow files ask first below Autonome', () => {
    for (const trustLevel of ['prudent', 'confiant'] as const) {
      expect(gates({ administer: trustLevel })).toEqual({
        'github.branch-protection-write': 'approval',
        'github.workflow-write-via-file': 'approval',
      });
    }
  });

  test('no macro-action of the catalog holds the fallback — the creator ticks "Anything else"', () => {
    const all = gates({
      read: 'autonome',
      propose: 'autonome',
      ship: 'autonome',
      administer: 'autonome',
    });
    expect(Object.keys(all)).not.toContain('github.uncategorized-write');
    expect(gates({ 'anything-else': 'prudent' })).toEqual({
      'github.uncategorized-write': 'approval',
    });
  });
});

describe('github credential spec — a fine-grained token', () => {
  test('the one way of connecting is a pasted fine-grained token, with its guide', () => {
    expect(githubCredential.kind).toBe('api-key');
    expect(githubCredential.fields.map((f) => [f.name, f.secret])).toEqual([['token', true]]);
    expect(githubCredential.createUrl).toBe('https://github.com/settings/personal-access-tokens');
    expect(githubCredential.guide?.permissions.map((p) => p.name)).toEqual([
      'Metadata',
      'Contents',
      'Pull requests',
      'Issues',
      'Actions',
      'Administration',
      'Workflows',
    ]);
  });

  test('the two mint risks of the App are deprecated, never removed', () => {
    const deprecated = githubCatalog.catalog.risks.filter((r) => r.deprecated).map((r) => r.id);
    expect(deprecated).toEqual([
      'github.mint-install-token-clone',
      'github.mint-install-token-push',
    ]);
    expect(githubPlugin.tools.map((t) => t.name)).not.toContain('github__mint_install_token');
  });

  test('classifier refuses a repository outside the mission even when another is in', () => {
    expect(
      classifyGithub('github__list_branches', { owner: 'acme', repo: 'lib' }, [appRepo]),
    ).toEqual({
      denied: "github repository 'acme/lib' is not selected in this mission. Selected: acme/app.",
    });
    const ok = classifyGithub('github__list_branches', { owner: 'acme', repo: 'lib' }, [
      appRepo,
      libRepo,
    ]);
    expect('slices' in ok).toBe(true);
  });
});
