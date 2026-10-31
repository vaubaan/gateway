---
title: Coding workflow
tracks:
  - .github/
  - scripts/
  - package.json
  - .husky/pre-commit
  - CONTRIBUTING.md
  - CHANGELOG.md
  - deploy/docker/Dockerfile
  - deploy/compose.yaml
  - .gitattributes
last_reviewed: 2026-10-31
---

# Coding workflow

Trunk-based on `main`, squash-merged pull requests, releases by a tag a maintainer pushes; the only
artefact is an image on GHCR. Decision:
[repository-layout-and-contribution-workflow](../decisions/repository-layout-and-contribution-workflow.md).
v4 documents are deleted; git and the tag `v4-final` are the archive.

## CI pipeline

- The [workflows](../../.github/workflows/) state their triggers and steps in their header comments.
  Required check: the job `audit`; locally `npm run ci` (lint only through the script: it needs the
  script's heap).
- **Billed minutes are the budget**: nothing runs on a draft or a push to `main`; open a pull
  request when it is ready, push a review round's fixes together.
- **Label `e2e`** a change to pages, components, styles, e2e tests or any plugin (the mission form
  is drawn from catalogs), or run `npm run test:e2e:v5` locally.
- Provider facts in handbooks, catalogs and plugins come from Context7 through the gateway's
  `context7` plugin, citing the pages it returned; a missing topic names the URLs fetched instead
  and is marked `_fallback: Context7 missing — check by hand at the next refresh_`.

### Dependency audit

- `scripts/audit-gate.mjs` gates `npm audit --omit=dev` against
  [the allowlist](../../.github/audit-allowlist.json): one GHSA id per package, a checkable reason,
  `review_by` at most a quarter after `reviewed`; a lapsed entry covers nothing. A registry outage
  is a warning on a merge, and fails a release run (a tag, or the `release` workflow): re-run it
  once the registry answers.
- When it fails: upgrade; without a fix, check reachability (`npm ls --all --omit=dev <package>`)
  and add an entry. Never raise the gated severities or drop the job.

### Security checks

- Security tools are supply chain too: never a third-party action; each is a release archive pinned
  by SHA-256 (`scripts/fetch-tool.sh`) or an image pinned by digest. Locally, the same `scripts/`.
- A true positive gets its own `fix(...)` commit with a test; a committed secret is **revoked at its
  issuer first**, history is not rewritten.
- A false positive is suppressed at the narrowest place with a checkable reason
  (`// nosemgrep: <rule> -- <why>`, a Trivy exception expiring within a quarter); never a directory
  or a severity raised. A fake secret in a test contains `0123456789`.

### Dependency updates

- [Dependabot](../../.github/dependabot.yml) batches updates, each pull request costing a CI run;
  security updates need the repository setting on. A base image bump also updates the docs quoting
  the version, pushed onto its branch.

### Refreshing the security tools

- gitleaks, Trivy, actionlint and Semgrep are invisible to Dependabot. Quarterly: a release at least
  a week old, version and hashes changed together, new findings triaged in the same pull request.

## Env variants

- Local: `npm run dev`, or `npm run demo` (simulated providers). e2e: the built app, `:memory:`
  store, simulated identity provider, mocked providers. No test reaches a real provider.
- Deployed instances run the released image on their operators' hosts
  ([`deploy/README.md`](../../deploy/README.md)). The commit they report comes from
  `apps/gateway/build-commit.txt` (`export-subst`, filled by `git archive`), never a build argument
  or platform variable (delete a leftover `GIT_COMMIT_SHA`).

## PR process

- One feature or fix per pull request, squash merged, its title a Conventional Commit.
- Every commit signed off (`git commit -s`, Developer Certificate of Origin, no CLA);
  `scripts/dco-check.mjs` in the job `audit` refuses a pull request with an unsigned commit, merges
  excepted.
- Before opening: `npm run ci` green, the [template](../../.github/PULL_REQUEST_TEMPLATE.md)
  answered, a bullet under `## [Unreleased]` of `CHANGELOG.md` for a user-visible change.

## Branch model

- `main` is the trunk, unprotected until publication (free plan, private repository). Work on
  `feature/*` or `fix/*` from `origin/main`, rebased right before the push. `v5` stays a pre-release
  source until `2.0.0`.

## Release

### One version

- The root `package.json` `version` is the gateway's only version (`version-single-source.test.ts`).

### Versioning policy

Semver. **Breaking** = an installation that worked stops working, or works differently, without its
owner doing anything:

| Surface                 | Breaking (major)                                                                                 | Not breaking (minor)                       |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| **Configuration keys**  | a key removed or renamed; optional made required; a default or format changing an existing setup | a new optional key; a new accepted value   |
| **Refusal codes**       | a code removed, renamed or given another meaning; a cause answered with another code             | a new code for a new cause                 |
| **Plugin SDK contract** | an export changed so a plugin that compiled and loaded no longer does                            | a new optional member; a new helper        |
| **Catalog ids**         | a provider id, tool name or macro-action id removed or renamed (a risk id never is)              | a new provider, tool, risk or macro-action |

- Also covered: both MCP doors and the OAuth endpoints, `/healthz`, the image's promises (uid 10001,
  `/data`, the port, exit code 78); a release that cannot migrate the store itself. Not covered:
  interface wording, logs, internal packages.
- A fix is a patch, even one refusing what was wrongly allowed (`### Security`). A plugin major
  needs a gateway major, unless the stricter classification is a security fix. Pre-releases
  (`-alpha.N`, `-beta.N`, `-rc.N`) never move `latest`.

### Cutting a release

1. Refresh the base images, then `npm run release:prepare -- <version>` on a branch, pull request
   `chore(release): <version>`, merge once green.
2. Only a maintainer tags, by hand: `git tag -a v<version> -m "Vaubaan Gateway <version>" <commit>`,
   `git push origin v<version>` publishes. A failed job is re-run; a version tag never moves.
3. Rollback: no downgrade (an older image refuses a newer database): fix forward, or restore a
   pre-upgrade backup with the previous image.

#### On a private repository

- No arm runner nor artifact attestation on this plan: a release ships `linux/amd64` only,
  unattested, and its notes say so.

### The OAuth broker's image

- A release of its own: a maintainer pushes `oauth-broker-v<version>` (the version of
  `apps/oauth-broker/package.json`, a commit on `main`);
  [`oauth-broker-image.yml`](../../.github/workflows/oauth-broker-image.yml) refuses anything else,
  and publishes nothing unless two builds give the same digest. Never marked latest; the gateway's
  `release.yml` ignores these tags.
- A broker release reaches instances only through a gateway release adding its digest to
  `broker-measurements.json`. Procedure and verification: handbook
  [oauth-broker](../handbook/oauth-broker.md).

### Refreshing the base image digests

Monthly (Dependabot), before every release, and on a Node 26 or Debian security release. Today:
`node:26.12.1-bookworm-slim` and `caddy:2.11.7-alpine`.

1. `docker buildx imagetools inspect node:<version>-bookworm-slim`: the digest of the
   multi-architecture index (amd64 and arm64 listed), never one platform's. Same tag, other digest:
   the pin is behind.
2. Change version and digest together, and where `deploy/README.md` and this section quote it;
   `npm run docker:build && npm run docker:smoke && npm run test`.
3. A Node major is at least a minor release, moving `node-version`, `engines.node` and `@types/node`
   with it.
4. `apps/oauth-broker/Dockerfile` uses the same `node` reference (its own test holds them equal): a
   new base is a new broker measurement, so a broker release follows.
