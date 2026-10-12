/**
 * Risk catalog tests (Phase 1, GitHub provider).
 *
 * The catalog YAML lives at `src/risk-catalog.yaml`. These tests :
 *
 *   1. Parse the YAML at load time and validate the shape against
 *      `RiskCatalog`.
 *   2. Parse every `matches` pattern through `parseSlice` — invalid
 *      patterns are a hard CI failure.
 *   3. Lint coverage : for every MCP tool defined by the provider, at
 *      least one catalog entry matches at least one slice emitted by
 *      `classifyGithubV4` on a representative call. A tool whose only
 *      matching entry is the fallback (`github.uncategorized-write`) is
 *      flagged as a warning — the fallback exists as a safety net, not as
 *      the *primary* classification.
 *
 * The synthetic args used by the lint are crafted to exercise the common
 * happy path for each tool. They are NOT exhaustive ; the
 * `risk-classifier.test.ts` file pins the contract on the slice shape.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';
import yaml from 'js-yaml';
import type { ProviderBinding, RiskCatalog, RiskEntry, Slice } from '@vaubaan/shared';
import { matches, parseSlice } from '@vaubaan/policy-engine';

import { availableTools } from '../../src/tools.ts';
import { classifyGithubV4 } from '../../src/risk-classifier.ts';

// ─── load + parse ──────────────────────────────────────────────────────────

const CATALOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/risk-catalog.yaml',
);

const catalog = yaml.load(readFileSync(CATALOG_PATH, 'utf8')) as RiskCatalog & {
  catalog_version?: number;
  catalog_date?: string;
};

// Tools retired by spec v4 §7.2 #1. The catalog does not have to cover them ;
// the classifier `denied`s them and the runtime rejects.
const RETIRED_TOOLS = new Set<string>([
  'github__dispatch_workflow',
  'github__cancel_workflow_run',
  'github__rerun_workflow_run',
]);

// Representative args per tool — minimal but sufficient to produce a slice.
// Branches default to `feature/test` so we exercise the feature-branch-write
// risk in addition to the more generic ones.
const repoRef = 'sbw-vaubaan/gateway';
const baseArgs = { owner: 'sbw-vaubaan', repo: 'gateway' };
const branch = 'feature/test';

const SYNTH_ARGS: Record<string, Record<string, unknown>> = {
  github__list_branches: { ...baseArgs },
  github__list_commits: { ...baseArgs },
  github__list_pull_requests: { ...baseArgs },
  github__list_issues: { ...baseArgs },
  github__get_file_contents: { ...baseArgs, path: 'README.md', ref: branch },
  github__get_pull_request: { ...baseArgs, pull_number: 1 },
  github__get_issue: { ...baseArgs, issue_number: 1 },
  github__get_commit: { ...baseArgs, sha: 'deadbeef' },
  github__list_releases: { ...baseArgs },
  github__list_tags: { ...baseArgs },
  github__list_workflows: { ...baseArgs },
  github__list_workflow_runs: { ...baseArgs, workflow_id: 'ci.yml' },
  github__get_branch_protection: { ...baseArgs, branch: 'main' },
  github__search_code: { q: 'foo' },
  github__search_issues: { q: 'foo' },
  github__create_branch: { ...baseArgs, branch },
  github__create_or_update_file: {
    ...baseArgs,
    branch,
    path: 'src/foo.ts',
    content: 'x',
    message: 'm',
  },
  github__push_files: {
    ...baseArgs,
    branch,
    message: 'm',
    files: [
      { path: 'a.ts', content: '1' },
      { path: 'b.ts', content: '2' },
    ],
  },
  github__delete_file: {
    ...baseArgs,
    branch,
    path: 'a.ts',
    message: 'm',
    sha: 'deadbeef',
  },
  github__create_pull_request: { ...baseArgs, title: 't', head: branch, base: 'main' },
  github__merge_pull_request: { ...baseArgs, pull_number: 1 },
  github__add_issue_comment: { ...baseArgs, issue_number: 1, body: 'b' },
  github__create_release: { ...baseArgs, tag_name: 'v1.0.0' },
  github__delete_release: { ...baseArgs, release_id: 1 },
  github__update_branch_protection: { ...baseArgs, branch: 'main' },
  github__mint_install_token: { purpose: 'push', repoFullName: repoRef },
};

const bindings: readonly ProviderBinding[] = [
  {
    id: 'pb-1',
    project_id: 'prj-1',
    provider: 'github',
    resource_ref: repoRef,
    display_name: null,
    environment: null,
    created_at: '2026-01-01T00:00:00Z',
  },
];

// ─── schema validation ─────────────────────────────────────────────────────

describe('GitHub risk catalog — schema', () => {
  test('parses as YAML to a non-null object', () => {
    expect(catalog).toBeTypeOf('object');
    expect(catalog).not.toBeNull();
  });

  test('declares provider = "github"', () => {
    expect(catalog.provider).toBe('github');
  });

  test('has a non-empty risks array', () => {
    expect(Array.isArray(catalog.risks)).toBe(true);
    expect(catalog.risks.length).toBeGreaterThan(0);
  });

  test('every entry has the required fields', () => {
    for (const entry of catalog.risks) {
      expect(entry.id, `entry id`).toMatch(/^github\./);
      expect(entry.label.length, `entry ${entry.id} label`).toBeGreaterThan(0);
      expect(entry.reason.length, `entry ${entry.id} reason`).toBeGreaterThan(0);
      expect(entry.matches, `entry ${entry.id} matches`).toBeDefined();
      expect(entry.vector, `entry ${entry.id} vector`).toBeDefined();
    }
  });

  test('every risk vector has the 6 axes filled', () => {
    for (const entry of catalog.risks) {
      const v = entry.vector;
      expect(['reversible', 'costly', 'irreversible']).toContain(v.reversibility);
      expect(['single', 'env', 'account', 'bulk']).toContain(v.blast);
      expect(['metadata', 'data', 'secret', 'pii']).toContain(v.data);
      expect(['free', 'moderate', 'unbounded']).toContain(v.cost);
      expect(['internal', 'team', 'public']).toContain(v.visibility);
      expect(['stateless', 'session', 'posture']).toContain(v.persistence);
    }
  });

  test('contains the mandatory fallback risk `github.uncategorized-write`', () => {
    const fb = catalog.risks.find((r) => r.id === 'github.uncategorized-write');
    expect(fb, 'fallback risk missing').toBeDefined();
    expect(fb!.matches).toBeDefined();
  });

  test('risk ids are unique', () => {
    const ids = catalog.risks.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every `matches` pattern parses via parseSlice', () => {
    for (const entry of catalog.risks) {
      const patterns = matchesAsArray(entry);
      expect(patterns.length, `entry ${entry.id} has empty matches`).toBeGreaterThan(0);
      for (const p of patterns) {
        expect(() => parseSlice(p), `entry ${entry.id} pattern '${p}'`).not.toThrow();
        const parsed = parseSlice(p);
        expect(parsed.provider, `entry ${entry.id} pattern provider`).toBe('github');
      }
    }
  });
});

// ─── tool coverage lint ────────────────────────────────────────────────────

describe('GitHub risk catalog — tool coverage lint', () => {
  const indexed = catalog.risks.map((entry) => ({
    entry,
    patterns: matchesAsArray(entry).map((p) => parseSlice(p)),
  }));

  for (const tool of availableTools) {
    if (RETIRED_TOOLS.has(tool.name)) continue;
    test(`${tool.name} is covered by at least one catalog entry`, () => {
      const args = SYNTH_ARGS[tool.name];
      expect(args, `no synthetic args for tool '${tool.name}'`).toBeDefined();
      const result = classifyGithubV4(tool.name, args!, bindings);
      if ('denied' in result) {
        // A structural denial counts as "not classifiable" — that's fine,
        // the runtime will reject the call regardless of catalog.
        throw new Error(`classifier denied '${tool.name}' on synthetic args: ${result.denied}`);
      }
      const matched = matchedEntries(result.slices, indexed);
      expect(
        matched.length,
        `tool '${tool.name}' touches no catalog entry — emitted slices: ${result.slices
          .map((s) => sliceKey(s))
          .join(', ')}`,
      ).toBeGreaterThan(0);
    });
  }

  test('every write tool also touches a fine-grained entry (not only the fallback)', () => {
    const fallbackOnly: string[] = [];
    for (const tool of availableTools) {
      if (RETIRED_TOOLS.has(tool.name)) continue;
      const args = SYNTH_ARGS[tool.name];
      if (!args) continue;
      const result = classifyGithubV4(tool.name, args, bindings);
      if ('denied' in result) continue;
      // Only check write slices — reads don't have a fallback by design.
      const hasWrite = result.slices.some((s) => s.action === 'W');
      if (!hasWrite) continue;
      const matched = matchedEntries(result.slices, indexed);
      const matchedIds = matched.map((m) => m.entry.id);
      const nonFallback = matchedIds.filter((id) => id !== 'github.uncategorized-write');
      if (nonFallback.length === 0) fallbackOnly.push(tool.name);
    }
    expect(fallbackOnly, 'tools that only hit the fallback risk').toEqual([]);
  });
});

// ─── helpers ───────────────────────────────────────────────────────────────

function matchesAsArray(entry: RiskEntry): string[] {
  return typeof entry.matches === 'string' ? [entry.matches] : Array.from(entry.matches);
}

interface IndexedEntry {
  entry: RiskEntry;
  patterns: Slice[];
}

function matchedEntries(slices: readonly Slice[], indexed: readonly IndexedEntry[]) {
  const out: IndexedEntry[] = [];
  for (const indexedEntry of indexed) {
    const hit = indexedEntry.patterns.some((pat) => slices.some((s) => matches(pat, s)));
    if (hit) out.push(indexedEntry);
  }
  return out;
}

/** Minimal slice serializer — independent of the policy-engine's helper so
 *  this file does not have to import it. Used only for error messages. */
function sliceKey(s: Slice): string {
  const parts = s.path.map((seg) => {
    switch (seg.kind) {
      case 'name':
        return seg.value;
      case 'ident':
        return `[${seg.value}]`;
      case 'list':
        return `[${seg.values.join(',')}]`;
      case 'wild-one':
        return '[*]';
      case 'wild-rec':
        return '[**]';
    }
  });
  return `${s.provider}.${parts.join('.')}.${s.action}`;
}
