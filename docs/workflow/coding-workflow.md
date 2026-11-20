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
  `scorecard.yml` publishes the OpenSSF Scorecard of the repository weekly and on every push to
  `main` (the README's badge).
  Required check: the job `audit`. Locally, `npm run check:changed` checks only what a change can
  break (type-check of the touched workspaces and their dependents, ESLint and Prettier on the
  changed files, the related Vitest tests, the harness linters, the Next build and its standalone tests when the build's inputs changed, and, with Docker, Semgrep as CI runs it); `npm run ci` is the full run (lint
  only through the script: it needs the script's heap), about 30 minutes on a small machine.
- **A push to `main` runs the full check** (`audit`, then `e2e`): maintainers push their changes
  to `main` directly, checked locally by `npm run check:changed`, and read the run's verdict after
  the push. Nothing runs on a draft pull request.
- **Label `e2e`** a change to pages, components, styles, e2e tests or any plugin (the mission form
  is drawn from catalogs), or run `npm run test:e2e` locally.
- Service facts in handbooks, catalogs and plugins come from Context7 through the gateway's
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

- Local: `npm run dev`, or `npm run demo` (simulated services). e2e: the built app, `:memory:`
  store, simulated identity provider, mocked services. No test reaches a real service.
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

- `main` is the trunk. Its protection refuses a force-push, a deletion and a merge commit
  (linear history), and asks for no pull request: maintainers push a squashed, signed-off commit
  per feature directly to `main`; contributors work on `feature/*` or `fix/*` from
  `origin/main`, rebased right before the push, and open a pull request. Every release, the
  pre-releases included, is tagged on `main`.
- These protections, the release tags' and the catalog's: `.github/settings/`, checked and
  reapplied by `scripts/github-settings.sh` (handbook [github-settings](../handbook/github-settings.md)).

## Release

### One version

- The root `package.json` `version` is the gateway's only version (`version-single-source.test.ts`).

### Versioning policy

Semver. **Breaking** = an installation that worked stops working, or works differently, without its
owner doing anything:

| Surface                 | Breaking (major)                                                                                 | Not breaking (minor)                      |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Configuration keys**  | a key removed or renamed; optional made required; a default or format changing an existing setup | a new optional key; a new accepted value  |
| **Refusal codes**       | a code removed, renamed or given another meaning; a cause answered with another code             | a new code for a new cause                |
| **Plugin SDK contract** | an export changed so a plugin that compiled and loaded no longer does                            | a new optional member; a new helper       |
| **Catalog ids**         | a service id, tool name or macro-action id removed or renamed (a risk id never is)               | a new service, tool, risk or macro-action |

- Also covered: both MCP doors and the OAuth endpoints, `/healthz`, the image's promises (uid 10001,
  `/data`, the port, exit code 78); a release that cannot migrate the store itself. Not covered:
  interface wording, logs, internal packages.
- A fix is a patch, even one refusing what was wrongly allowed (`### Security`). A plugin major
  needs a gateway major, unless the stricter classification is a security fix. Pre-releases
  (`-alpha.N`, `-beta.N`, `-rc.N`) never move `latest`.

### Cutting a release

1. Refresh the base images, then `npm run release:prepare -- <version>` on a branch (it also writes
   `apps/website/src/content/releases.json`, the released gateway and plugin versions of the
   versions feed), pull request `chore(release): <version>`, merge once green.
2. Only a maintainer tags, by hand: `git tag -a v<version> -m "Vaubaan Gateway <version>" <commit>`,
   `git push origin v<version>` publishes. A failed job is re-run; a version tag never moves.
3. Rollback: no downgrade (an older image refuses a newer database): fix forward, or restore a
   pre-upgrade backup with the previous image.

#### On a private repository

- No arm runner nor artifact attestation on this plan: a release ships `linux/amd64` only,
  unattested, and its notes say so.

### Plugin releases

- A plugin version is released by the catalog alone, never by the gateway's repository (ADRs
  [plugins-installed-when-first-needed](../decisions/plugins-installed-when-first-needed.md),
  [plugin-catalog-rebuilt-from-source](../decisions/plugin-catalog-rebuilt-from-source.md),
  amendment 2026-11-19): bump the plugin's version here (package.json, `definePlugin`, the
  lockfile entry), CHANGELOG, an entry in `apps/website/src/content/advisories.json` when it fixes
  a security issue; push to main; then a pull request on `vaubaan/gateway-plugins` moves its
  declaration to the new `version` and `commit`. Once merged, the catalog rebuilds, signs and
  publishes `<id>-v<version>` and its `index.json` (GitHub Pages), which every instance reads at
  its next versions check. Nothing else in this repository moves.
- [`catalog-versions.json`](../../apps/gateway/src/server/plugins/catalog-versions.json) — the
  catalog versions a gateway release knows, `{ name, version, sha256 }` — is written by
  `npm run release:prepare` from the catalog's index of that day (`--catalog-index <file or URL>`
  to read another): the fallback when an instance cannot read the index, and what a start
  installs for the plugins its accounts need. `releases.json` takes the index's versions too, for
  gateways released before the index. Nothing of it is preinstalled.

### The plugin kit

- `@vaubaan/plugin-sdk` and `@vaubaan/plugin-cli` are published to npm by
  [`publish-plugin-kit.yml`](../../.github/workflows/publish-plugin-kit.yml), on a tag
  `npm-plugin-sdk-v<version>` or `npm-plugin-cli-v<version>` (never `plugin-…-v…`: `release.yml`
  takes those for a plugin's image). Bump the package's `version`, CHANGELOG, merge, then a
  maintainer pushes the tag on the merged commit. The SDK goes first when the CLI needs its new
  version: the job refuses a CLI whose SDK is not on npm.
- Before publishing, the job runs `scripts/plugin-kit-smoke.sh`: both packages packed, installed
  in an empty folder, `vaubaan-plugin init`, then the new project's `npm run check`, `try` and
  `build`. Run it locally after any change to the kit's packaging (about 15 seconds).
- No token: npm **trusted publishing**, **staged**. On npmjs.com each package names this
  repository and `publish-plugin-kit.yml` as its trusted publisher with **no allowed action
  checked** ("Allow npm publish" and "Allow npm dist-tag" left off): the workflow may only
  `npm stage publish`. A staged version stays hidden until a maintainer approves it with their
  second factor, on npmjs.com (the package's staged versions) or with `npm stage list <package>`
  then `npm stage approve <id>` (npm 11.15 or later); the job's summary says what to approve.
  "Publishing access" requires two-factor authentication and disallows tokens.
- npm declares a trusted publisher only for a package that exists: the first version of each
  package was published by hand on 2026-11-18 (`@vaubaan/plugin-sdk` 0.9.4,
  `@vaubaan/plugin-cli` 0.1.0, by `dev-vaubaan`). A new package of the kit starts the same way:
  `npm pack --workspace <package>`, `npm publish <tarball> --access public` from a maintainer's
  login, in a real terminal (the browser's second-factor prompt needs one), then the trusted
  publisher declared as above.

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
`node:26.13.1-bookworm-slim` and `caddy:2.11.9-alpine`.

1. `docker buildx imagetools inspect node:<version>-bookworm-slim`: the digest of the
   multi-architecture index (amd64 and arm64 listed), never one platform's. Same tag, other digest:
   the pin is behind.
2. Change version and digest together, and where `deploy/README.md` and this section quote it;
   `npm run docker:build && npm run docker:smoke && npm run test`.
3. A Node major is at least a minor release, moving `node-version`, `engines.node` and `@types/node`
   with it.
4. `apps/oauth-broker/Dockerfile` uses the same `node` reference (its own test holds them equal): a
   new base is a new broker measurement, so a broker release follows.
