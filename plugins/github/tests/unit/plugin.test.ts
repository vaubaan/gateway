/**
 * Mandatory structural suite of the github plugin (spec §10) : the SDK kit,
 * catalog coverage of every declared tool, the fallback lint, the presets
 * and the credential spec. The classifier branches are pinned in
 * `classify.test.ts`, the risks each tool touches in `risk-catalog.test.ts`,
 * upstream calls in `execute.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { pluginIssues, writeHandoutRiskIds, type Resource } from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
} from '@vaubaan/plugin-sdk/testing';

import { classifyGithub, githubCatalog, githubCredential, githubPlugin } from '../../src/index.ts';
import { appRepo, executeCtx, libRepo, mintRoute } from './fixtures.ts';

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
  github__mint_install_token: [
    { args: { purpose: 'clone', repoFullName: 'acme/app' } },
    { args: { purpose: 'push' } },
    { args: { purpose: 'merge' }, expectDenied: true },
  ],
  github__list_workflows: [{ args: { ...repo } }],
  github__list_workflow_runs: [{ args: { ...repo } }, { args: { ...repo, workflow_id: 'ci.yml' } }],
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
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(githubPlugin);
    assertPresetsValid(githubPlugin);
    assertNoWildcard(githubPlugin);
  });

  test('26 tools declared, all prefixed', () => {
    expect(githubPlugin.tools).toHaveLength(26);
    for (const t of githubPlugin.tools) expect(t.name.startsWith('github__')).toBe(true);
  });

  test('every tool classifies to slices a named risk covers ; no sample slice lands on the fallback', () => {
    const report = assertCatalogCoverage(githubPlugin, samples, { resources });
    // The 26 MCP tools and the git remote's two.
    expect(report.toolsChecked).toBe(28);
    // The 18 named risks, in catalog order ; the fallback is not among them.
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
      'github.mint-install-token-clone',
      'github.mint-install-token-push',
    ]);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  // What is executed is what was classified (SDK kit) : every string argument of
  // every sample above is fed the hostile identifiers, through `classify` and
  // through `execute`. The finer cases are in this plugin's identifier tests.
  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(githubPlugin, samples, {
      resources,
      context: (fetch, missionResources) => executeCtx(fetch, missionResources),
      // The installation token is minted before the call that carries the identifiers.
      routes: [mintRoute()],
    });
    expect(report.toolsChecked).toBe(26);
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

describe('github catalog — presets', () => {
  const presets = githubCatalog.catalog.presets;
  const byId = Object.fromEntries(presets.map((p) => [p.id, p]));
  const risksOf = (id: string) => byId[id]!.entries.map((e) => e.risk_id);
  const entry = (preset: string, risk: string) =>
    byId[preset]!.entries.find((e) => e.risk_id === risk);

  test('ships read-only, developer and release-manager', () => {
    expect(presets.map((p) => p.id)).toEqual(['read-only', 'developer', 'release-manager']);
    expect(githubCatalog.catalog.catalog_version).toBe(7);
  });

  test('read-only grants reads only, no search, gate auto', () => {
    expect(risksOf('read-only')).toEqual(['github.read-code', 'github.read-meta']);
    for (const e of byId['read-only']!.entries) expect(e.gate).toBe('auto');
  });

  test('developer writes on feature branches and PRs, never on protected branches or admin surfaces', () => {
    const dev = risksOf('developer');
    for (const id of [
      'github.read-code',
      'github.read-meta',
      'github.search-global',
      'github.feature-branch-write',
      'github.bulk-file-write',
      'github.create-pr',
      'github.comment-write',
    ]) {
      expect(dev).toContain(id);
    }
    for (const id of [
      'github.merge-protected',
      'github.branch-protection-write',
      'github.create-release',
      'github.delete-release',
    ]) {
      expect(dev).not.toContain(id);
    }
    expect(entry('developer', 'github.workflow-write-via-file')?.gate).toBe('approval');
    // Catalog v6 : git goes through the gateway's remote ; a force-push asks first,
    // and no preset hands a token that leaves (the mint risks are added by hand).
    expect(entry('developer', 'github.git-push')?.gate).toBe('auto');
    expect(entry('developer', 'github.force-push')?.gate).toBe('approval');
    for (const id of [
      'github.mint-install-token-clone',
      'github.mint-install-token-push',
      'github.branch-delete',
      'github.tag-write',
    ]) {
      expect(dev).not.toContain(id);
    }
  });

  test('release-manager pushes tags with git, each asking first', () => {
    expect(entry('release-manager', 'github.git-push')?.gate).toBe('auto');
    expect(entry('release-manager', 'github.tag-write')?.gate).toBe('approval');
  });

  // Spec §2.4: a token that can write is handed after approval; the clone token is
  // read-only (`contents:read`) and is the only one a preset may leave on auto.
  test('the push token is gated in every preset that carries it; only the clone token is declared read-only', () => {
    expect(githubPlugin.tokenHandouts).toEqual([
      {
        tool: 'github__mint_install_token',
        riskIds: ['github.mint-install-token-clone', 'github.mint-install-token-push'],
        readOnlyRiskIds: ['github.mint-install-token-clone'],
      },
    ]);
    for (const preset of presets) {
      const push = preset.entries.find((e) => e.risk_id === 'github.mint-install-token-push');
      if (push) expect(push.gate, preset.id).toBe('approval');
    }
    expect([...writeHandoutRiskIds(githubPlugin)]).toEqual(['github.mint-install-token-push']);
    expect(pluginIssues(githubPlugin)).toEqual([]);
    // No shipped preset carries a mint risk since catalog v6 ; a preset that put the
    // clone token on auto is still checked against the declaration.
    const withClone = {
      ...githubPlugin,
      catalog: {
        ...githubPlugin.catalog,
        presets: githubPlugin.catalog.presets.map((p) =>
          p.id !== 'developer'
            ? p
            : {
                ...p,
                entries: [
                  ...p.entries,
                  {
                    risk_id: 'github.mint-install-token-clone',
                    quota: 50,
                    rate_limit: { max: 5, window_seconds: 60 },
                    gate: 'auto' as const,
                  },
                ],
              },
        ),
      },
    };
    expect(pluginIssues(withClone)).toEqual([]);
    // Without the declaration the clone token is taken as write, and the preset is refused.
    const undeclared = {
      ...withClone,
      tokenHandouts: (githubPlugin.tokenHandouts ?? []).map(({ tool, riskIds }) => ({
        tool,
        riskIds,
      })),
    };
    expect(pluginIssues(undeclared)).toEqual([
      expect.stringContaining(
        "preset 'developer': 'github.mint-install-token-clone' hands the agent a token that can write",
      ),
    ]);
  });

  test('release-manager gates merge-protected, create-release and delete-release on approval', () => {
    expect(entry('release-manager', 'github.merge-protected')?.gate).toBe('approval');
    expect(entry('release-manager', 'github.create-release')?.gate).toBe('approval');
    expect(entry('release-manager', 'github.delete-release')?.gate).toBe('approval');
    expect(risksOf('release-manager')).not.toContain('github.branch-protection-write');
  });

  test('no preset offers the fallback risk — the creator opts in explicitly', () => {
    for (const preset of presets) {
      expect(risksOf(preset.id)).not.toContain('github.uncategorized-write');
    }
  });
});

describe('github credential spec — app-install', () => {
  test('declares the company app settings and the installation callback parameter', () => {
    expect(githubCredential.kind).toBe('app-install');
    expect(githubCredential.installationIdParam).toBe('installation_id');
    expect(githubCredential.appConfigFields.map((f) => [f.name, f.secret])).toEqual([
      ['app_id', false],
      ['private_key', true],
      ['app_slug', false],
      ['client_id', false],
      ['client_secret', true],
    ]);
  });

  test('declares how the host binds an installation to the installing GitHub user', () => {
    // "Request user authorization (OAuth) during installation" : the callback carries
    // `code` ; the host exchanges it and reads GET /user/installations (100 per page).
    expect(githubCredential.userVerification).toEqual({
      codeParam: 'code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientAuthMethod: 'client_secret_post',
      installationsUrl: 'https://api.github.com/user/installations',
      installationsHeaders: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'vaubaan-gateway',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      installationsListField: 'installations',
      installationIdField: 'id',
      pagination: { pageParam: 'page', perPageParam: 'per_page', perPage: 100 },
    });
    // Declarative only : the plugin exposes no code path that takes the client secret.
    expect(Object.values(githubCredential.userVerification ?? {})).not.toContainEqual(
      expect.any(Function),
    );
  });

  test('builds the installation URL from the app slug, or fails naming the key', () => {
    expect(githubCredential.installUrl({ app_slug: 'vaubaan-gateway' })).toBe(
      'https://github.com/apps/vaubaan-gateway/installations/new',
    );
    expect(() => githubCredential.installUrl({})).toThrow(/app_slug/);
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
