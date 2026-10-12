/**
 * GitHub — risk catalog (TS export, 1:1 with `risk-catalog.yaml`).
 *
 * Source of truth : `.vaubaan/research/providers/github.md` §3.
 * Spec           : `docs/spec/gateway-risk-model.md` §4.
 *
 * The YAML sibling is the canonical reviewable form ; this TS module is
 * what the runtime imports (no YAML dep at runtime — Vercel does not bundle
 * `.yaml` files in the Lambda). Keep both in sync — a CI test in
 * `tests/unit/risk-catalog-sync.test.ts` diffs the two structures.
 *
 * 14 fine-grained risks + 1 fallback `github.uncategorized-write` = 15 total.
 * Bracket lists may mix exact names and globs (`[main,master,release-*]`)
 * — the slice-dsl parser accepts them.
 */

import type { RiskCatalog } from '@vaubaan/shared';

export const githubRiskCatalog: RiskCatalog = {
  provider: 'github',
  risks: [
    // ─── READS ─────────────────────────────────────────────────────────────
    {
      id: 'github.read-code',
      label: 'Read code, branches, commits, files',
      reason:
        'Reads may leak secrets through `.env`-style commits (rare but non-zero). The ' +
        "contents of fetched files are attacker-injectable into the agent's context " +
        '(OWASP LLM01) — a malicious README can steer a downstream prompt.',
      matches: [
        'github.repo[**].branch[**].R',
        'github.repo[**].branch[**].file[**].R',
        'github.repo[**].commit[**].R',
        'github.repo[**].branch[**].commit[**].R',
        'github.repo[**].tag[**].R',
      ],
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'github.read-meta',
      label: 'Read PRs, issues, releases, workflows, branch-protection',
      reason:
        'Repository metadata. Issue/PR bodies are attacker-controlled (OWASP LLM01) — ' +
        'handle with care on the agent side. Reading branch protection rules is ' +
        'diagnostic only, never dangerous in itself.',
      matches: [
        'github.repo[**].pull_request[**].R',
        'github.repo[**].issue[**].R',
        'github.repo[**].issue[**].comment[**].R',
        'github.repo[**].release[**].R',
        'github.repo[**].workflow[**].R',
        'github.repo[**].workflow-run[**].R',
        'github.repo[**].workflow[**].workflow-run[**].R',
        'github.repo[**].branch-protection[**].R',
      ],
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'github.search-global',
      label: 'Global GitHub search (code / issues, out of bindings)',
      reason:
        'Search traverses every public GitHub repo plus every repo the App installation ' +
        'has access to. Cross-org leakage is possible if the App is installed widely. ' +
        'Sensitivity is low by default but the surface is account-shaped, not ' +
        'project-shaped.',
      matches: ['github.search.code.R', 'github.search.issues.R'],
      vector: {
        reversibility: 'reversible',
        blast: 'account',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },

    // ─── WRITES — branches feature/* (low-risk, the coding-agent hot loop) ─
    {
      id: 'github.feature-branch-write',
      label: 'Create/modify branches under feature/*, fix/*, chore/*, …',
      reason:
        'Reversible (`git revert` or branch delete). No production side effect until ' +
        'merged. This is the heart of the coding-agent flow.',
      matches: [
        'github.repo[**].branch[feature/*,fix/*,chore/*,bug/*,docs/*,refactor/*].W',
        'github.repo[**].branch[feature/*,fix/*,chore/*,bug/*,docs/*,refactor/*].file[**].W',
        'github.repo[**].branch[feature/*,fix/*,chore/*,bug/*,docs/*,refactor/*].files-bulk.W',
      ],
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },

    // ─── WRITES — protected branches (main / master / release-* / prod) ────
    {
      id: 'github.merge-protected',
      label: 'Write on main / master / release-* (direct commit OR PR merge)',
      reason:
        'The canonical branch — triggers downstream CI/CD on prod. Costly to revert ' +
        '(release notes, communications, downstream dependencies). Covers direct ' +
        'commits (create_or_update_file without a PR) AND merges of PRs whose base is ' +
        'one of these branches.',
      matches: [
        'github.repo[**].branch[main,master,prod,production,release-*].W',
        'github.repo[**].branch[main,master,prod,production,release-*].file[**].W',
        'github.repo[**].branch[main,master,prod,production,release-*].files-bulk.W',
        'github.repo[**].branch[main,master,prod,production,release-*].merge-into.W',
      ],
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'moderate',
        visibility: 'team',
        persistence: 'session',
      },
    },

    // ─── WRITES — workflow YAML files (privilege escalation vector) ────────
    {
      id: 'github.workflow-write-via-file',
      label: 'Modify a GitHub Actions workflow (.github/workflows/*.yml)',
      reason:
        "The CI YAML defines what runs with the repo's secrets. Modifying a workflow " +
        'is a potential privilege-escalation vector (steal secrets via curl to ' +
        'attacker-controlled domain). Spec v4 §7.2 #1 retired `dispatch_workflow` for ' +
        'this reason — but the attack persists through file writes on the YAML itself.',
      matches: ['github.repo[**].branch[**].workflow-via-file.W'],
      vector: {
        reversibility: 'costly',
        blast: 'account',
        data: 'secret',
        cost: 'free',
        visibility: 'internal',
        persistence: 'posture',
      },
      // Acceptable only on feature/fix/chore branches, never directly on
      // main (the merge path forces a PR + human review).
      acceptable_in_envs: ['feature', 'fix', 'chore'],
    },

    // ─── WRITES — bulk multi-file push (push_files) ────────────────────────
    {
      id: 'github.bulk-file-write',
      label: 'Bulk multi-file push (push_files)',
      reason:
        'A single commit touching many files. Harder to review manually than a ' +
        'single-file write. Kept distinct from file-by-file so the manager can ' +
        'opt-in/out specifically — useful signal for spotting malicious or buggy ' +
        'agents. Emitted as a `files-bulk` virtual leaf alongside the per-file ' +
        '`file[<path>].W` slices.',
      matches: ['github.repo[**].branch[**].files-bulk.W'],
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },

    // ─── WRITES — pull requests & comments ─────────────────────────────────
    {
      id: 'github.create-pr',
      label: 'Open a pull request',
      reason:
        'No prod mutation. Notifies reviewers (visibility=team). PR title and body are ' +
        'reviewer-injectable.',
      matches: [
        'github.repo[**].pull_request[**].W',
        'github.repo[**].branch[**].propose-to[**].W',
      ],
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'team',
        persistence: 'session',
      },
    },
    {
      id: 'github.comment-write',
      label: 'Comment on an issue or PR',
      reason:
        'A comment on a PR notifies reviewers ; on an issue, subscribers. Low risk but ' +
        'pollution / spam potential if abused.',
      matches: [
        'github.repo[**].issue[**].comment[**].W',
        'github.repo[**].pull_request[**].comment[**].W',
      ],
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'team',
        persistence: 'session',
      },
    },

    // ─── WRITES — releases (potentially public publication) ────────────────
    {
      id: 'github.create-release',
      label: 'Create a release (potentially public publication)',
      reason:
        'With `draft=false && prerelease=false`, the release is publicly visible, ' +
        'notifies watchers, and triggers `on: release` workflows. Hard to "retract" — ' +
        'downstream consumers may already have pulled tarballs / asset URLs by the ' +
        'time you delete.',
      matches: ['github.repo[**].release[**].W', 'github.repo[**].tag[**].W'],
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'metadata',
        cost: 'free',
        visibility: 'public',
        persistence: 'session',
      },
    },
    {
      id: 'github.delete-release',
      label: 'Delete a release',
      reason:
        'Irreversible w.r.t. audit / external notifications. The tag itself persists, ' +
        'but the release body and assets vanish — downstream consumers may see 404s.',
      matches: ['github.repo[**].release[**].W'],
      vector: {
        reversibility: 'irreversible',
        blast: 'env',
        data: 'metadata',
        cost: 'free',
        visibility: 'public',
        persistence: 'session',
      },
    },

    // ─── WRITES — branch protection (posture-shift) ────────────────────────
    {
      id: 'github.branch-protection-write',
      label: 'Modify branch protection',
      reason:
        'Posture-shift : opens the branch to out-of-process writes (e.g. disabling ' +
        "required reviews). Persists after the token's lifetime. Even when " +
        '*tightening* (adding a required check), the change outlives the session.',
      matches: ['github.repo[**].branch-protection[**].W'],
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'metadata',
        cost: 'free',
        visibility: 'team',
        persistence: 'posture',
      },
    },

    // ─── WRITES — credential mint (install token, two purposes) ────────────
    {
      id: 'github.mint-install-token-clone',
      label: 'Mint an install token (purpose=clone, read-only)',
      reason:
        'Credential creation, but scoped to `contents:read` only. The token has its ' +
        'own TTL (1h) and its own scope. Moderate risk : code extraction is possible, ' +
        'no mutation.',
      matches: ['github.repo[**].install-token[clone].W'],
      vector: {
        reversibility: 'reversible',
        blast: 'account',
        data: 'secret',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },
    {
      id: 'github.mint-install-token-push',
      label: 'Mint an install token (purpose=push, write)',
      reason:
        'Credential creation with `contents:write + pull_requests:write + ' +
        "workflows:write`. The token leaves the gateway's gating perimeter ; no " +
        'Vaubaan policy applies to usages of this credential. De-facto posture-shift.',
      matches: ['github.repo[**].install-token[push].W'],
      vector: {
        reversibility: 'reversible',
        blast: 'account',
        data: 'secret',
        cost: 'free',
        visibility: 'internal',
        persistence: 'posture',
      },
    },

    // ─── FALLBACK — catch-all (mandatory per spec §4) ──────────────────────
    {
      id: 'github.uncategorized-write',
      label: 'Uncategorized GitHub write (fallback)',
      reason:
        'Catch-all for writes not explicitly categorized above. If observed in ' +
        'production, it signals a missing catalog entry — add the specific risk before ' +
        'the next release. Operators must opt in explicitly (no implicit accept).',
      matches: ['github.repo[**].W'],
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },
  ],
};
