/**
 * Mandatory structural suite of the github plugin (spec §10) : the SDK kit,
 * catalog coverage of every declared tool, the fallback lint, the presets
 * and the credential spec. The classifier branches are pinned in
 * `risk-classifier.test.ts` ; upstream calls in `execute.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { prepareCatalog, risksTouchedByAll } from '@vaubaan/policy-engine';
import type { Resource } from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
} from '@vaubaan/plugin-sdk/testing';

import { classifyGithub, githubCatalog, githubCredential, githubPlugin } from '../../src/index.ts';
import { appRepo, libRepo } from './fixtures.ts';

const repo = { owner: 'acme', repo: 'app' };
const feature = 'feature/test';

/** One realistic call per tool ; branches default to feature/* and main so both write classes are exercised. */
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
    { args: { ...repo, pull_number: 1, base: feature } },
  ],
  github__delete_file: [
    { args: { ...repo, branch: feature, path: 'a.ts', message: 'm', sha: 'd' } },
  ],
  github__update_branch_protection: [{ args: { ...repo, branch: 'main' } }],
  github__list_releases: [{ args: { ...repo } }],
  github__list_tags: [{ args: { ...repo } }],
  github__create_release: [{ args: { ...repo, tag_name: 'v1.0.0' } }],
  github__delete_release: [{ args: { ...repo, release_id: 1 } }],
} as const;

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

  test('every tool classifies to slices the catalog covers, and every risk is reachable', () => {
    const report = assertCatalogCoverage(githubPlugin, samples, { resources });
    expect(report.toolsChecked).toBe(26);
    expect(report.risksUntouched).toEqual([]);
    expect(report.risksTouched).toEqual(githubCatalog.catalog.risks.map((r) => r.id));
  });

  test('no write tool touches only the fallback risk', () => {
    const indexed = prepareCatalog(githubCatalog.catalog, { warn: () => undefined });
    const fallbackOnly: string[] = [];
    for (const [tool, calls] of Object.entries(samples)) {
      for (const call of calls) {
        const out = classifyGithub(tool, call.args, resources);
        if ('denied' in out) continue;
        if (!out.slices.some((s) => s.action === 'W')) continue;
        const touched = risksTouchedByAll(out.slices, indexed);
        if (touched.every((id) => id === 'github.uncategorized-write')) {
          fallbackOnly.push(`${tool} ${JSON.stringify(call.args)}`);
        }
      }
    }
    expect(fallbackOnly).toEqual([]);
  });

  test('a write on an unconventional branch is caught by the fallback alone', () => {
    const indexed = prepareCatalog(githubCatalog.catalog, { warn: () => undefined });
    const out = classifyGithub(
      'github__create_or_update_file',
      { ...repo, branch: 'wip-x', path: 'a.ts', content: '', message: 'm' },
      resources,
    );
    if ('denied' in out) throw new Error(out.denied);
    expect(risksTouchedByAll(out.slices, indexed)).toEqual(['github.uncategorized-write']);
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
    expect(githubCatalog.catalog.catalog_version).toBe(2);
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
    expect(entry('developer', 'github.mint-install-token-push')?.gate).toBe('approval');
    expect(entry('developer', 'github.mint-install-token-clone')?.gate).toBe('auto');
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
      denied: "repo 'acme/lib' is not bound to this project",
    });
    const ok = classifyGithub('github__list_branches', { owner: 'acme', repo: 'lib' }, [
      appRepo,
      libRepo,
    ]);
    expect('slices' in ok).toBe(true);
  });
});
