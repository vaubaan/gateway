---
title: Coding workflow
status: current
date: 2026-05-22
last_synced: 2026-10-19
tracks:
  - .github/
  - .semgrep/
  - .semgrepignore
  - .gitleaks.toml
  - .gitleaksignore
  - .trivyignore.yaml
  - scripts/fetch-tool.sh
  - scripts/secret-scan.sh
  - scripts/sast.sh
  - scripts/image-scan.sh
  - scripts/lockfile-gate.mjs
  - scripts/tsconfig.json
  - package.json
  - tsconfig.base.json
  - vitest.config.ts
  - apps/gateway/tests/e2e/v5/playwright.config.ts
  - eslint.config.js
  - .husky/pre-commit
  - CONTRIBUTING.md
  - deploy/docker/Dockerfile
  - deploy/docker/smoke.sh
  - scripts/audit-gate.mjs
  - scripts/release-lib.mjs
  - scripts/release-prepare.mjs
  - scripts/release-plan.mjs
  - scripts/release-image-index.sh
  - scripts/stamp-commit.sh
  - .gitattributes
  - CHANGELOG.md
---

# Coding workflow

How the repository is laid out, what runs locally and in CI, how branches
and releases work during the v5 build. The v4 SaaS workflow (Vercel
preview deploys, Supabase migrations) is gone; see the ADR
[repository-layout-and-contribution-workflow](../decisions/repository-layout-and-contribution-workflow.md).

## Layout

The repository is an npm workspaces monorepo with three roots:

```
apps/gateway/            the deployable: server + Next.js UI       @vaubaan/gateway-app (private)
packages/shared/         risk types, api-key, data-model            @vaubaan/shared
packages/policy-engine/  slices, matching, the risk decision, the validity rule of a budget  @vaubaan/policy-engine
packages/plugin-sdk/     plugin contract, registry, test kit        @vaubaan/plugin-sdk
packages/gateway-core/   pipeline, decisions, refusals, audit       @vaubaan/gateway-core
packages/telemetry/      opt-in telemetry report, queue, client     @vaubaan/telemetry
plugins/<provider>/      one provider plugin per folder             @vaubaan/plugin-<provider>
plugins/_template/       scaffold for a new plugin                  @vaubaan/plugin-template
deploy/                  Dockerfile, compose, Caddy, example config, telemetry collector SQL
docs/                    spec, decisions, handbook, tests, workflow
scripts/                 gen-master-key.mjs (npm run gen-master-key), audit-gate.mjs and lockfile-gate.mjs (CI job audit), secret-scan.sh, sast.sh, image-scan.sh, fetch-tool.sh (security checks), release-*.mjs and release-image-index.sh (npm run release:prepare, release.yml)
```

- `workspaces`: `apps/*`, `packages/*`, `plugins/*`. A new library goes
  under `packages/`, a new provider under `plugins/<provider-id>` named
  `@vaubaan/plugin-<provider-id>`, a new deployable under `apps/`.
- Every workspace has its own `tsconfig.json` extending
  `../../tsconfig.base.json` and a `type-check` script; `npm run
type-check` at the root fans out to all of them.
- Root files for contributors: `README.md`, `LICENSE` (Apache-2.0),
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`,
  four issue forms under `.github/ISSUE_TEMPLATE/` (`bug_report`,
  `feature_request`, `plugin_request`, `catalog_correction`; blank issues disabled) and
  `.github/PULL_REQUEST_TEMPLATE.md` (checklist: spec, ADR, handbook, tests,
  English, no hard-coded configuration, `npm run ci`, CHANGELOG).
- Historical v4 documents are marked `status: legacy` or moved to
  `docs/**/legacy/` (ADR
  [legacy-status-of-v4-adrs-and-handbooks](../decisions/legacy-status-of-v4-adrs-and-handbooks.md)).
- Nothing in the repository depends on Vercel or Supabase: the v4
  application code and its `@supabase/*` dependencies were deleted with
  the v4 application.

## TypeScript and lint baseline

- `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `useUnknownInCatchVariables`, ES2022, bundler resolution,
  `allowImportingTsExtensions` (packages import `./x.ts` directly).
- `eslint.config.js` (flat config, ESLint 9): `recommendedTypeChecked`,
  `no-floating-promises` and `no-misused-promises` as errors,
  `consistent-type-imports` (inline), `no-console` as a warning outside
  `scripts/` (`console.warn` / `console.error` allowed); `--max-warnings=0`
  makes warnings fail. Config files, Next
  outputs, the agent worktrees under `.claude/worktrees/` and the Semgrep
  rule test cases (`.semgrep/`) are ignored. Linting is typed: one
  TypeScript program per workspace stays open (the app's alone parses about
  1 700 files, 1.1 GB in `tsc`), and the scripts are one program of their own
  (`scripts/tsconfig.json`, `allowJs`, not type-checked) rather than one
  default project per file. The whole run peaks near 2.8 GB, past Node's
  default heap: `npm run lint` and `lint:fix` start ESLint with
  `--max-old-space-size=6144`. Call the script, not `npx eslint .`.
- Prettier formats everything (`npm run format`, `format:check`).

## Scripts

| Script                             | What it does                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm run ci`                       | type-check, lint, format:check, build, test — the gate of CI's `check`, `lint` and `test` jobs          |
| `npm run type-check`               | `tsc --noEmit` in every workspace, in parallel, incremental (`scripts/type-check.mjs`)                  |
| `npm run lint` / `lint:fix`        | ESLint over the repository                                                                              |
| `npm run format` / `format:check`  | Prettier write / check                                                                                  |
| `npm run build`                    | every workspace `build` (today: `next build` of `apps/gateway`)                                         |
| `npm run test` / `test:watch`      | Vitest, whole suite (`test`: project `shared` without isolation, then `isolated`)                       |
| `npm run test:e2e` (`test:e2e:v5`) | builds `apps/gateway`, then Playwright on the ephemeral instance (CI job `e2e`)                         |
| `npm run dev`                      | `next dev` of `apps/gateway`                                                                            |
| `npm run demo`                     | builds when the sources changed, then the demo instance on `http://localhost:3210` (handbook demo-mode) |
| `npm run gen-master-key`           | prints a fresh 32-byte base64 master key                                                                |
| `npm run docker:build`             | builds `deploy/docker/Dockerfile` as `vaubaan-gateway:local`                                            |
| `npm run docker:smoke`             | runs `deploy/docker/smoke.sh` against that image                                                        |
| `npm run release:prepare -- <v>`   | cuts the changelog section and sets the version; creates no commit and no tag                           |
| `prepare`                          | installs the husky hook (`husky \|\| true`, never fails an install)                                     |

Tests: Vitest collects `apps/*/tests/{unit,integration}`,
`packages/*/tests/{unit,integration}`, `plugins/*/tests/unit` (`.test.ts`;
`.test.tsx` too under the `tests/unit` roots of apps and packages) and
co-located `*.test.ts` under `apps/*/src` and `packages/*/src`, and `scripts/*.test.mjs` (the release
helpers); `apps/*/tests/e2e/**` is excluded and belongs to
Playwright. No test can reach a real provider. Scenarios: [`docs/tests/`](../tests/).

## Local gate

`.husky/pre-commit` runs `npx lint-staged` on staged files only. The
configuration lives in the root `package.json`:

- `*.{ts,tsx,js,mjs,cjs}` → `eslint --max-warnings=0 --no-warn-ignored`,
  `prettier --check`;
- `*.{md,json,yaml,yml,css,html}` → `prettier --check`.

It takes seconds. Type-check, tests and the production build are **not**
run by the hook; they run in CI on every push and pull request, and
`npm run ci` reproduces the full gate by hand. Emergency bypass (do not
abuse): `git commit --no-verify`.

## CI (`.github/workflows/ci.yml`)

Triggers: push and pull request to `main` and `v5`, `workflow_dispatch`,
and `workflow_call` — the release pipeline calls this file as its gates
([Release](#the-release-pipeline-githubworkflowsreleaseyml)). One concurrency
group per workflow and ref with `cancel-in-progress` (`github.workflow` is
the caller's name in a called run, so a release and the CI of the same ref
never cancel each other); `permissions: contents: read`. Linux runners,
Node 22. Every job that needs the dependencies goes through
`.github/actions/setup`: `node_modules` is cached by the hash of
`package-lock.json`; on a miss, `npm ci --no-audit --no-fund` installs
exactly the lockfile, or fails. The jobs run in parallel: a run lasts as long
as its longest job.
Every action is pinned by commit, as
in `release.yml`, with the release it is in a comment: a tag can be moved, a
commit cannot.

```yaml
jobs:
  scope: # scripts/ci-scope.sh: code=false when only docs/** or *.md changed; surface=true when a page, a component, a style, a browser test or a plugin changed
  check: # if code
    - npm audit signatures # registry signatures and provenance of what is installed
    - npm run type-check # every workspace in parallel, tsc incremental (build info cached)
    - npm run format:check # Prettier cache restored
    - npm run build --workspace @vaubaan/website # VAUBAAN_BUILD_TYPECHECKED=1
  lint: # if code
    - npm run generate --workspace @vaubaan/website # the .source/ collections its types need
    - npm run lint # pull request: ESLint cache restored; push: every file
  test: # if code; three shards
    - npx vitest run --project shared --no-isolate --shard=<n>/3
    - npx vitest run --project isolated # last shard only
  docs: # if not code
    - npm run format:check
    - npx vitest run <every test file naming docs/ or a .md file>
  audit: # no install; timeout 5 min
    - node scripts/audit-gate.mjs # npm audit --omit=dev against .github/audit-allowlist.json
    - node scripts/lockfile-gate.mjs # npmjs registry only, https, sha512, the package named
    - actionlint # the workflows (pinned by checksum; shellcheck on every run:)
  secrets: # full clone; timeout 5 min
    - scripts/secret-scan.sh # gitleaks over the whole history
  sast: # timeout 10 min
    - checkout semgrep/semgrep-rules at a pinned commit
    - docker run --network none semgrep/semgrep@sha256:… scripts/sast.sh
  e2e: # if code, and on a pull request only if surface (push to main/v5, release gates: always); timeout 20 min
    - npx playwright install chromium # browser cached by version; the runner has Chrome's libraries
    - npm run test:e2e:v5 # next build (no tsc pass), then Playwright on the ephemeral instance
    - npx vitest run … standalone-* demo/ # the suites that need the build (skipped in `test`)
    - on failure: upload test-results/v5 (traces, screenshots) for 7 days
  docker: # schedule and manual runs of ci.yml only (each release builds its own image)
    - docker/build-push-action (deploy/docker/Dockerfile, push: false, load: true,
      GitHub Actions layer cache; scripts/stamp-commit.sh first writes the
      checked-out commit into apps/gateway/build-commit.txt, no build argument)
    - deploy/docker/smoke.sh vaubaan-gateway:ci
    - scripts/image-scan.sh vaubaan-gateway:ci # Trivy; vulnerability DB cached a day
```

**Caches.** `type-check`, `format:check` and `lint` keep what they already
checked (`*.tsbuildinfo`, `.cache/prettier`, `.cache/eslint`; gitignored)
and check again only what changed, by content. A cache holds results, never
a verdict on a changed file. The one blind spot is ESLint's: a file whose
content did not change is not linted again when a type it imports changed,
so a push to `main` or `v5` lints every file. `next build` skips its own
tsc pass when `VAUBAAN_BUILD_TYPECHECKED=1` (`npm run ci`, CI); the image
build type-checks as before.

**What a pull request waits for.** `check`, `lint`, `test` and the
security jobs: about two minutes. The browser tests (`e2e`, a production
build and the scenarios in series, about four minutes) run on a pull request
only when `scope` finds a change that can alter what the browser shows
(`surface=true`: `apps/gateway/src/app/**`, `src/components/**`,
`src/styles/**`, `apps/gateway/tests/e2e/**`, or any `plugins/**` file, since
the reference and the mission form are drawn from the plugins' catalogs,
presets and tools). A change confined to the server, the packages or the
scripts does not wait for them. They run on every push to `main`, whatever
changed, and in the release gates. The image (`docker`, about five minutes)
is built by the release pipeline for each architecture, and weekly by this
workflow for the vulnerability scan. A browser regression in a server-only
change is therefore seen on `main`, never in a release; one in a page or a
plugin is seen on the pull request (on 2026-10-18 two plugin and form
changes merged green and left `main` red for a day, which is why).

**Documentation only.** A push or pull request that changes only `docs/**`
or Markdown files runs `scope`, `docs` and the security jobs (`audit`,
`secrets`, `sast`): the tests that read the documentation — the structural
index against the spec, the key table of the configuration handbook — still
run.

Weekly (Monday 05:23 UTC, `schedule`), the same file runs its security jobs
only — `audit`, `secrets`, `sast` and `docker` with its scan; `check`,
`lint`, `test`, `docs` and `e2e` are skipped — so a new advisory or a new rule finds what an unchanged
tree already ships. GitHub runs a schedule from the default branch only:
it starts at the cutover. Every other branch is scanned for secrets on each
push by `.github/workflows/secrets.yml`.

The `docker` job builds the single gateway image and runs the container
smoke test described in [`docs/tests/e2e-tests.md`](../tests/e2e-tests.md)
(fail-fast exit naming the key, https rule, `/healthz`, secret redaction,
native addons, non-root, no package manager, no env file shipped, no test file shipped). The image is not published; that is the release
pipeline's job ([Release](#release)). No Node matrix, no cross-OS.

### Dependency audit

The `audit` job runs `node scripts/audit-gate.mjs`: `npm audit --omit=dev
--json` on the lockfile (nothing is installed, no install script runs),
compared with the reviewed allowlist `.github/audit-allowlist.json`. Because
the release pipeline calls `ci.yml`, the same gate stands in front of every
release.

| What the run finds                                                                                                                                | Result                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| no advisory, or only allowlisted ones                                                                                                             | pass                                                   |
| an advisory not in the list, of any severity other than `info` and `low` (`moderate`, `high`, `critical`, and any level the script does not know) | **fail**, one error annotation per advisory            |
| an advisory the list names for another package than the report does                                                                               | **fail**: an entry covers one package                  |
| an allowlisted advisory whose `review_by` date has passed                                                                                         | **fail**: the review lapsed                            |
| an advisory of severity `low` or `info`                                                                                                           | pass, listed as a notice                               |
| an allowlist entry that matches nothing in this tree                                                                                              | pass, notice (prune it)                                |
| the registry does not answer after four attempts (2 s, 8 s, 20 s between)                                                                         | pass, with a **warning** annotation                    |
| the allowlist is invalid; `npm audit` printed nothing or could not be started; the output is neither a report nor an outage                       | fail (exit 2, `unreadable`): the gate itself is broken |

A registry outage is not a vulnerability: it never fails a merge or a
release, and the warning says that no advisory was checked by that run. The
two cases are told apart by what `npm audit --json` printed (a report, or an
`error` whose code or text is a network or registry failure —
`parseAuditOutput`), never by the exit code. An outage is recognised on what
was written, never on silence: an empty output, or one that cannot be parsed
and names no registry failure, is `unreadable` and exits 2.

Advisories are compared per pair (advisory id, package): one advisory that
names several packages is checked once for each, and an allowlist entry,
which names one id and one package, covers that pair only. Only `info` and
`low` are listed without gating (`UNGATED_SEVERITIES`); a severity the script
does not know is gated, not read as harmless.

**When the gate fails**, in this order:

1. Upgrade. `npm update <package>` when the fixed version is within the
   ranges already declared (a lockfile-only change); otherwise bump the direct
   dependency that brings it.
2. If no fixed version exists, or the upgrade is not possible now, read the
   advisory and decide whether the vulnerable code is reachable **in what the
   instance runs**: `npm ls --all --omit=dev <package>` says which dependency
   brings it. Only then add an entry to `.github/audit-allowlist.json`:
   `id` (one GHSA id — never a wildcard, never a package-wide mute),
   `package`, `reason` (why it does not apply here, in a sentence a reviewer
   can check), `reviewed` (today) and `review_by` (at most a quarter later).
   The pull request that adds the entry is reviewed like code.
3. Never raise the gated severities or remove the job to get a release out.

**Review cadence.** Every entry carries its own `review_by`, at most about a
quarter after `reviewed` (`scripts/audit-gate.test.mjs` holds the bound). On
that date the gate fails until somebody looks again: upgrade if a fix exists
now, otherwise re-read the advisory, then move both dates. Entries that no
longer match anything are removed in the same pass. Before every release,
`node scripts/audit-gate.mjs` is run once by hand so a lapsed review is not
discovered by the release pipeline.

The `e2e` job runs the browser tests of
`apps/gateway/tests/e2e/v5/` — the cutover smoke among them — against an
ephemeral instance: the built app on the real composition root with the
`:memory:` store, a simulated identity provider and a mocked provider. It
needs no secret and reaches no network besides the Chromium download. It is
not part of `npm run ci`, which stays the `check` job's gate; run it locally
with `npm run test:e2e:v5` (after `npx playwright install chromium` once).
The cutover acceptance scenario itself is manual and is never run by CI
([`docs/tests/e2e-tests.md`](../tests/e2e-tests.md)).

### Security checks

Why and the tools chosen: ADR
[supply-chain-and-ci-security-checks](../decisions/supply-chain-and-ci-security-checks.md).
Every tool is pinned: a release archive checked against its SHA-256
(`scripts/fetch-tool.sh`) or an image by digest; no third-party action runs
a scan. Each check runs locally with the same script as in CI.

| Check                     | Where it runs                                                                                 | Local command                                                              | Fails on                                                                                                             | Reviewed exceptions                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Secrets (gitleaks)        | `ci.yml` `secrets`; `secrets.yml` on every other branch; weekly                               | `scripts/secret-scan.sh` (full clone)                                      | a secret anywhere in the history                                                                                     | `.gitleaks.toml` (exact value or file), `.gitleaksignore` (fingerprint of a deleted file) |
| Static analysis (Semgrep) | `ci.yml` `sast`; weekly                                                                       | `scripts/sast.sh <semgrep-rules checkout>`, or the `docker run` of the job | any finding of the pinned community security rules or of `.semgrep/vaubaan.yml`; a custom rule whose test cases fail | inline `// nosemgrep: <rule> -- <why>`; `.semgrepignore` (paths)                          |
| Image (Trivy)             | `ci.yml` `docker`; `release.yml` `image`, per architecture, before anything is pushed; weekly | `npm run docker:build && scripts/image-scan.sh vaubaan-gateway:local`      | HIGH or CRITICAL with a fixed version, Debian or npm layer                                                           | `.trivyignore.yaml` (id, purl, statement, `expired_at`)                                   |
| Dependency advisories     | `ci.yml` `audit`                                                                              | `node scripts/audit-gate.mjs`                                              | [Dependency audit](#dependency-audit)                                                                                | `.github/audit-allowlist.json`                                                            |
| Lockfile                  | `ci.yml` `audit`                                                                              | `node scripts/lockfile-gate.mjs`                                           | an entry from another registry, over http, without sha512, or downloading another package                            | none: fix the lockfile                                                                    |
| Registry signatures       | `ci.yml` `check`                                                                              | `npm audit signatures` (after `npm ci`)                                    | an installed package whose signature or attestation does not verify                                                  | none                                                                                      |
| Workflows                 | `ci.yml` `audit`                                                                              | `actionlint`                                                               | a workflow error, a shellcheck finding in a `run:`                                                                   | none                                                                                      |
| Parsers (fast-check)      | `npm run test`                                                                                | `FC_SEED=<s> FC_RUNS=<n> npx vitest run <file>`                            | a counter-example                                                                                                    | none: fix the parser, keep the counter-example as a case                                  |

**Triage, in this order.**

1. **Read the finding where it is**, not in the summary: the line, the
   value, the package and the path it was found at.
2. **True positive: fix it**, in its own commit (`fix(...)`), with a test
   that would have caught it. A committed secret is **revoked at its issuer
   first**; the history is not rewritten to hide it. A vulnerable package:
   upgrade it, or the base image ([Refreshing the base image
   digests](#refreshing-the-base-image-digests)).
3. **False positive: suppress it at the narrowest place, with the reason a
   reviewer can check** — on its line for Semgrep
   (`nosemgrep: <rule> -- <why>`; a bare `nosemgrep` is refused in review),
   the exact value or file for gitleaks, one id and one purl with an
   `expired_at` at most a quarter away for Trivy. Never a whole directory,
   a rule switched off for the repository, or a severity raised.
4. **Fixed upstream, not yet here** (a Debian fix the Node image has not
   picked up): an expiring Trivy exception naming what clears it.

A fake secret in a test contains `0123456789` (`'pat_fake_0123456789'`): the
secret scan ignores it by construction and it needs no entry.

**Cost in Actions minutes** (the plan has 2 000 a month; a job is billed by
the started minute). Per CI run of `main`, `v5` or a pull request: `secrets`
1, `sast` 2 (the Semgrep image is about 1.5 GB to pull), Trivy about 1
more inside `docker` (database cached a day), the lockfile gate and
actionlint seconds inside `audit`, `npm audit signatures` about 10 s inside
`check`: **about +4 minutes** on top of the earlier 20 to 25. Each push of a
work branch: 1 (`secrets.yml`). The weekly run: about 8 (no `check`, no
`e2e`). At 60 CI runs and 150 work-branch pushes a month, about 430
minutes, of which about 420 are new. The release adds one Trivy scan per
architecture.

### Dependency updates

`.github/dependabot.yml`, read from the default branch (it starts at the
cutover), proposes once a week, Monday morning: npm updates (minor and patch
in two groups, production and development; each major alone), the Node base
image of the Dockerfile (new digest of the pinned tag, or a new 22.x; never
a new Node major: the ABI of the native addons), Caddy in the Compose file,
and the actions (grouped; commit and version comment move together). Each
waits a **cooldown** before it is proposed — 4 days for a patch or an
image, 7 for a minor or an action, 14 for a major — so a version published
in the last 72 hours is never adopted. Security updates are not delayed by
the cooldown when Dependabot security updates are enabled in the
repository settings. A base image bump with a new version also needs the
documentation that quotes it (`base-images-pinned` fails until it does):
push that change onto the Dependabot branch. A Dependabot pull request is
reviewed like any other: read the changelog of what moved, and the
lockfile diff.

### Refreshing the security tools

The versions and hashes of gitleaks, Trivy and actionlint live in
`scripts/fetch-tool.sh`; the Semgrep image digest and the
`semgrep/semgrep-rules` commit in `ci.yml` (`sast`). Dependabot does not
see them. Once a quarter, or when a tool announces a fix: take a release
**at least a week old**, read its checksums file (or the asset digest of
the GitHub release), change the version and both hashes together, run the
scripts once locally, and read the new findings before merging. A new
rules commit may bring new findings: triage them in the same pull request.

## Docker image

`deploy/docker/Dockerfile` is a multi-stage build (`manifests` → `deps` →
`build` → `runner`) on `node:22.23.3-bookworm-slim`, pinned by digest (glibc,
for the prebuilt `argon2` and `better-sqlite3` addons). The runner stage copies the Next.js
standalone output, runs as uid 10001, exposes `PORT` (3000), declares the
`/data` volume and a `HEALTHCHECK` on `/healthz`. The base image is named,
with its digest, on the `FROM … AS base` line itself (no build argument, so
Dependabot can propose its bumps); no build argument: the commit `/healthz`
reports is the stamp `git archive` writes into `apps/gateway/build-commit.txt`
(the CI and release jobs run `scripts/stamp-commit.sh`; ADR
[deployed-commit-stamped-by-git-archive](../decisions/deployed-commit-stamped-by-git-archive.md)). The
`deps` stage runs `npm ci`, as the CI jobs do. The runner stage removes the
package managers of the base image (npm, npx, corepack, yarn): the gateway
never runs them, and the smoke test checks they are gone. `.dockerignore` keeps `.git`, docs, test
artefacts, every `.env*` file except `.env.example` and every `*.pem` out of
the build context. Operator
documentation: [`deploy/README.md`](../../deploy/README.md).

## Database migrations

The schema is owned by the application and applied **at process boot** by
an in-house forward-only runner (ADR
[embedded-store-sqlite-and-migrations](../decisions/embedded-store-sqlite-and-migrations.md),
handbook [store](../handbook/store.md)). Nothing runs in CI for migrations;
the rules for contributors are:

- A schema change is a **new file** `apps/gateway/migrations/NNNN_name.sql`
  (four-digit, strictly increasing, lowercase slug). Never edit an applied
  file: the runner records a SHA-256 checksum and refuses to boot on a
  mismatch. It also refuses to boot when the database carries a migration
  the image does not ship (downgrade protection).
- Portable SQL only; mark the unavoidable SQLite-specific spots with a
  `-- sqlite:` comment (today: `STRICT`, `RAISE(ABORT)`), so a Postgres port
  can grep them.
- The migration tests (`apps/gateway/tests/unit/server/store/migrate.test.ts`,
  `apps/gateway/tests/integration/store/schema.test.ts`) run with the
  regular `npm run test`; the schema test lists every table and asserts
  they are all `STRICT`, so a new table updates that list.
- Operators never run migrations: starting the new image migrates the
  volume; a rollback to an older image against a newer schema fails fast
  naming the migration.

## Branches and pull requests

- `main` is protected. During the v5 build, work happens on
  `feat/<id>-<slug>` (or `fix/*`) branches created from the `v5`
  integration branch; the orchestrator merges them into `v5` with a merge
  commit (no fast-forward), and `v5` reaches `main` at milestones. CI runs
  on pushes and PRs to both.
- One feature or fix per pull request. Pull requests into `main` are squash
  merged (`CONTRIBUTING.md`).
- Commit messages follow Conventional Commits (`feat(scope):`,
  `fix(scope):`, `docs:`, `refactor(repo):`, `chore:`).
- Before opening a PR: `npm run ci` green locally, the PR template
  checklist answered, CHANGELOG `Unreleased` updated.

## Release

Decision and rejected alternatives: the amendment "Release" of the ADR
[repository-layout-and-contribution-workflow](../decisions/repository-layout-and-contribution-workflow.md#amendment-2026-10-13--release).
The public product name is v2 while the repository's plan calls the same
work v5; release tags are `v2.x.y`. Nothing has been released yet: no
`v2.*` tag exists and no image is published. The cutover of the `v5`
branch to `main` ([below](#cutover-of-v5-to-main)) is done, so releases
are cut from `main`.

### One version

The version of the gateway is the `version` of the root `package.json`, and
nothing else states it. `apps/gateway/next.config.ts` freezes it into the
bundle at build time (`NEXT_PUBLIC_GATEWAY_VERSION`, next to the commit),
`server/config/build-info.ts` reads that stamp, and from there it reaches
`/healthz` (`version`, `commit`), the footer of every page
(`components/shell/BuildFooter.tsx`), the MCP server info of both doors and
the telemetry field `gateway_version`. The workspaces under `apps/` and
`packages/` keep `0.0.0`: they are not published. Between two releases the
branch carries the version of the last release; the commit tells the builds
apart. `apps/gateway/tests/unit/structural/version-single-source.test.ts`
holds the two ends together.

### Versioning policy

Semantic versioning, applied to what an operator, an agent or a plugin
author relies on. A change is **breaking** — a major version — when an
installation that worked stops working, or works differently, without its
owner doing anything:

| Surface                 | Breaking                                                                                                                                                                                      | Not breaking (minor)                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Configuration keys**  | a key or its `VAUBAAN_*` variable removed or renamed; an optional key made required; a default or a format changed so that an existing file or environment is refused or means something else | a new optional key; a new accepted value |
| **Refusal codes**       | a code removed or renamed; a code given another meaning; a call that answered one code now answering another for the same cause                                                               | a new code for a new cause               |
| **Plugin SDK contract** | anything exported by `@vaubaan/plugin-sdk` removed or changed so that a plugin that compiled and loaded no longer does (`ProviderPlugin`, `CredentialSpec`, the test kit)                     | a new optional member; a new helper      |
| **Catalog ids**         | a provider id, a tool name or a preset id removed or renamed. A **risk id is never renamed or removed**, in any version (ADR plugin-contract-and-credential-spec, D4)                         | a new provider, tool, risk or preset     |

The same rule covers the paths and credentials of the two MCP doors and of
the OAuth endpoints, the shape of `/healthz`, and what the image promises
its host (uid 10001, the `/data` volume, the port, exit code 78 on a refused
configuration). The store is migrated forward at boot by every version; a
release that could not do so by itself would be a major one. Running an
older image on a newer database is refused by design and is not a
compatibility promise.

Not part of the contract: the layout and wording of the interface, log
message texts, and the workspace-internal packages (`@vaubaan/shared`,
`@vaubaan/policy-engine`, `@vaubaan/gateway-core`, `@vaubaan/telemetry`).

A fix is a patch. A fix that makes the gateway refuse what it wrongly
allowed is still a patch or a minor: it ships under `### Security` in the
changelog and names what is now refused.

### Pre-releases

`2.x.y-alpha.N`, `2.x.y-beta.N`, `2.x.y-rc.N` — these three stages, a dot,
a number counted from 1 (`2.0.0-alpha.0` is the stamp of the tree before
its first release and is never tagged). **alpha**: features still missing;
**beta**: feature complete, the contract may still move; **rc**: only fixes
until the final version. Pre-releases promise no compatibility with one
another. A pre-release publishes the image under its own version only —
never `latest`, never `<major>.<minor>` — and its GitHub release is marked
as a pre-release. The release scripts refuse any other spelling.

### Plugin versions

Each plugin has its own semantic version (`version` in its `definePlugin`),
which is what telemetry reports as `plugin_version`; its rules are ADR plugin-contract-and-credential-spec, D9.
Plugins live in this repository and ship inside the image: a gateway release
contains exactly the plugin versions of its commit, and the gateway version
does not follow theirs. What a plugin bump asks of the gateway release that
carries it:

| Plugin bump                                        | Gateway release                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| patch                                              | patch or more                                                                     |
| minor (new tool, risk, preset; widened `matches`)  | minor or more                                                                     |
| major (tool removed, classification made stricter) | major — or minor/patch when the stricter classification is a security fix (above) |

The changelog entry of a plugin change names the plugin and its new version.
`@vaubaan/plugin-sdk` and the plugins are not published to npm; the release
pipeline publishes one artefact, the image.

### Changelog discipline

Every user-visible change adds a bullet under `## [Unreleased]` in the pull
request that makes it (PR template checklist). A release moves that section
under `## [<version>] - <date>`; the release pipeline takes the body of the
GitHub release from it and refuses a tag whose section is missing, undated,
empty or still titled `Unreleased`. The release notes of a final version
also carry the sections of its pre-releases, newest first.

### Cutting a release

Releases are cut from `main`; until the cutover, pre-releases may also be
cut from `v5`. Only a maintainer pushes a release tag, by hand. No script,
workflow or agent creates one.

1. Refresh the base images if a newer patch exists
   ([below](#refreshing-the-base-image-digests)); merge that first.
2. `npm run release:prepare -- <version>` on a branch. It moves `Unreleased`
   to a dated section (and rewrites the compare links at the end of the
   file), sets the version in `package.json` and `package-lock.json`, and
   prints the commands of the next steps. It refuses a version that does not
   come after the current one, a spelling outside the policy, and an empty
   `Unreleased` (except to promote a release candidate unchanged). It
   creates no commit and no tag. `--date YYYY-MM-DD` overrides today's date
   (UTC).
3. Commit (`chore(release): <version>`), open the pull request, merge once
   CI is green.
4. Optional rehearsal: run the `release` workflow by hand on that branch
   (Actions → release → Run workflow). A manual run is a **dry run**.
5. Tag the merged commit and push the tag:
   `git tag -a v<version> -m "Vaubaan Gateway <version>" <commit>`, then
   `git push origin v<version>`. The push publishes.

### The release pipeline (`.github/workflows/release.yml`)

Triggers: the push of a tag `v2.*.*`, and `workflow_dispatch`. One
concurrency group per ref, never cancelled. `permissions: {}` at the top;
each job states its own. Every action is pinned by commit, with the version
in a comment.

| Job       | Runs on      | Permissions                                                                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | ------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`    | tag, dry run | `contents: read`                                                                                          | `scripts/release-plan.mjs`: the tag names the version of `package.json`, is the highest release so far, and `CHANGELOG.md` has its dated section; the tagged commit is on `main` (a pre-release: or on `v5`). Outputs the version, the image tags, the release notes, and what this repository can publish — the architectures to build and whether an attestation is signed ([below](#on-a-private-repository)); its summary lists what is left out, if anything.                                                                                                                                                                                                                                                                                                                                                                                          |
| `gates`   | tag, dry run | `contents: read`                                                                                          | Calls `ci.yml` itself (`workflow_call`): `scope` (always `code=true` there), `check`, `lint`, `test`, `audit`, `secrets`, `sast`, `e2e`. A release passes what a pull request passes, and the browser tests; the image is built, smoke-tested and scanned by `image` below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `image`   | tag, dry run | `contents: read`                                                                                          | One native runner per architecture of the plan (`ubuntu-24.04`, `ubuntu-24.04-arm`; no emulation): builds the image without reading any cache, runs `deploy/docker/smoke.sh` on it with the expected version, commit and architecture, scans it with Trivy (`scripts/image-scan.sh`: a fixed HIGH or CRITICAL fails the release before anything is pushed), writes its SBOM (SPDX, Syft) as a workflow artefact.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `push`    | tag only     | `contents: read`, `packages: write`                                                                       | Per architecture, after `gates` and `image`: pushes the image to GHCR **by digest, without a tag**, from the layers `image` built in this run, with BuildKit's SBOM and provenance (`mode=max`) attached; pulls that digest back and runs the smoke test on it; writes the SBOM of what was pushed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `publish` | tag only     | `contents: read`, `packages: write`, `id-token: write`, `attestations: write`, `artifact-metadata: write` | `scripts/release-image-index.sh`: assembles the digests — exactly one per planned architecture, checked — into one image index under `<version>`, with its OCI annotations; signs a build-provenance attestation for its digest (`actions/attest`, stored on GitHub and next to the image) and verifies it at once with `gh attestation verify` as an operator would (repository, signer workflow, tag) — no attestation, or one that does not verify, fails the job; only then points the aliases of a final release (`<major>.<minor>`, `latest`) at that digest. On a private repository the plan has decided there is no attestation: both steps are skipped, a step writes that to the summary, and the aliases move on that decision. A version tag never moves: an existing one is kept when it holds the same images (a re-run), refused otherwise. |
| `release` | tag only     | `contents: write`                                                                                         | Refuses to start without the verified attestation of `publish` when the plan expected one; then `gh release create --verify-tag`: title `Vaubaan Gateway <version>`, body from the changelog section plus the pull and verify commands and, on a private repository, a paragraph on what was left out; one SBOM file per architecture as assets; marked pre-release, or latest for a final version.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Image: `ghcr.io/<owner>/<repository>`, lower-cased — today
`ghcr.io/vaubaan/gateway`. Tags: `<version>`; a final release
also moves `<major>.<minor>` and `latest`. Because those two only move
forward, a tag older than an existing release is refused: no maintenance
branch is published.

A dry run runs `plan`, `gates` and `image`; the three jobs that hold a write
permission are skipped, so nothing is pushed, attested, tagged or released.
When the changelog has no section for the version of the tree yet, the dry
run warns and previews `Unreleased` instead of failing. GitHub only offers a
manual run for a workflow file present on the default branch, `main`; the
run may select any ref. A tag has no such limit — it runs the workflow file
of its own commit.

A tag never publishes an image the gates did not pass (`push` needs
`gates`), never tags an image that was not smoke-tested from the registry
(`publish` needs `push`), never moves `latest` to an image without an
attestation, and never announces an image that is not there (`release` runs
last). A run that fails after `push` leaves untagged digests in the
registry; one that fails at the attestation leaves the version tag as well,
without its aliases and without a GitHub release. In both cases fix the
cause and re-run the failed jobs: the version tag is kept as it is. If the
GitHub release already exists, `release` fails rather than overwrite it.

Both architectures are published because both native addons ship a prebuilt
glibc binary for them: `argon2` carries `linux-x64` and `linux-arm64` in its
package, `better-sqlite3` downloads `linux-x64` or `linux-arm64` for the
Node ABI of the base image at install time, and the base image index has
both. The smoke test loads the two addons on each architecture at every
release, so a dependency bump that loses one fails the release instead of
shipping a broken image.

#### On a private repository

Two things the pipeline uses are GitHub's to give, not the workflow's: the
`ubuntu-24.04-arm` hosted runner, which public repositories get and a
private repository gets only on a plan that includes it (a job asking for
it otherwise waits for a runner that never comes), and artifact
attestations, which GitHub offers to public repositories on every plan and
to private ones on Enterprise Cloud only. So the plan reads
`github.event.repository.private` and decides, once, what this repository
publishes (`publicationScope` in `scripts/release-lib.mjs`):

| Repository | Architectures                   | Attestation                                     | Everything else                                                           |
| ---------- | ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| public     | `linux/amd64` and `linux/arm64` | signed, verified, required by `release`         | gates, smoke tests, scan, SBOMs, image index, version tag, GitHub release |
| private    | `linux/amd64` only              | none; the aliases of a final release still move | the same                                                                  |

This is what anyone who forks the repository and keeps the fork private
gets, and the decision is never silent: the summary of the `plan` job
lists what is left out and why, `publish` writes the same under the
digest it tagged, and the GitHub release carries a paragraph "Built from a
private repository" with the same two items and no verify command. The
dry run takes the same decision, so a rehearsal on a private repository
builds `amd64` only and waits for nothing. `scripts/release-image-index.sh`
is told the planned architectures and refuses a set of digests that does
not match them exactly: a `push` job that did not run is a failure, not a
smaller image. A public repository gets the whole plan, unchanged, and
there a missing attestation still fails `publish` and `release`.

The release scripts are plain Node (`scripts/release-lib.mjs`, pure
functions; `release-prepare.mjs` and `release-plan.mjs` do the I/O) and are
tested by `scripts/release-lib.test.mjs` on a fixture changelog and, end to
end, in a temporary copy of the three files they touch.
`scripts/release-image-index.sh` (bash, `docker buildx imagetools`, `jq`)
has no automated test: it needs a registry, and was rehearsed by hand
against a local one.

### Refreshing the base image digests

The image is built on `node:<version>-bookworm-slim` pinned by digest
(the `FROM … AS base` line of `deploy/docker/Dockerfile`), and
`deploy/compose.yaml` pins `caddy:<version>-alpine` the same way. A pinned
digest does not receive the security fixes of its tag, so it is refreshed:
Dependabot proposes the new digest or patch version every week (after the
cutover, [Dependency updates](#dependency-updates)); by hand before every
release, and when Node 22 or Debian publishes a security release — the
weekly image scan fails when a fixed vulnerability waits in the pinned image.

0. To know whether a refresh is due without a new version: the same tag is
   rebuilt when Debian publishes fixes, so
   `docker buildx imagetools inspect node:<pinned version>-bookworm-slim`
   answering another `Digest:` than the one on the `FROM … AS base` line means the
   pinned image is behind its own tag. Same check for Caddy.
1. `docker buildx imagetools inspect node:<new version>-bookworm-slim` and
   read the `Digest:` line — the digest of the multi-architecture index,
   never of one platform. Check that `linux/amd64` and `linux/arm64` are
   both listed.
2. Change the version and the digest **together** on the `FROM … AS base` line, and
   the version where the documentation quotes it (`deploy/README.md`, the
   "Docker image" section above). Same for Caddy in `deploy/compose.yaml`.
3. `npm run docker:build && npm run docker:smoke`, and `npm run test`: the
   structural suite holds that both references are `name:tag@sha256:<64 hex>`
   and that the documentation quotes the pinned versions
   (`apps/gateway/tests/unit/structural/base-images-pinned.test.ts`).
4. Pull request `chore(deps): base image node <version>`, with a changelog
   bullet under `### Security` or `### Changed`.

The base stays a Debian (glibc) image of the Node 22 line. Another Node
major changes the ABI the prebuilt addons are downloaded for: it is a minor
release at least, and both architectures must pass the smoke test first.
The actions of `ci.yml` and `release.yml` are refreshed the same way: the commit and the
version comment change together.

### Cutover of `v5` to `main`

Done on 2026-10-16: the merge commit `681415ed` brought `v5` onto `main`
(the last v4 release is the tag `v4-final`; the v4 `main` is tagged
`main-before-v5`). It was one manual step, done by Renaud and by nobody
else: no feature branch, workflow or agent merged into `main`, pushed to it
or opened that pull request. The procedure, kept for the record:

1. Before: the work planned for the first release is merged into `v5`, CI is green on `v5`, the manual
   cutover acceptance scenario of
   [`docs/tests/e2e-tests.md`](../tests/e2e-tests.md) has been run, and the
   tag `v4-final` exists.
2. Renaud opens the pull request `v5` → `main` and merges it with a **merge
   commit** — the one exception to the squash rule: the history of the build
   is kept.
3. After: CI is green on `main`, and the two links of
   `.github/ISSUE_TEMPLATE/config.yml` (`…/tree/main/docs`,
   `…/blob/main/plugins/README.md`) resolve — GitHub reads the issue forms
   from the default branch, so they take effect with this step. Work
   branches start from `main` from then on. `v5` is kept until `2.0.0` is released, then deleted, and
   `PRERELEASE_BRANCH` leaves `release.yml` with it.

Cutting over an existing v4 _deployment_ is a different matter:
[cutover-from-v4](../handbook/cutover-from-v4.md).

## Doc-first discipline

Before writing code that:

- takes a structural decision → an ADR (`/decision`, or by hand under
  `docs/decisions/<slug>.md`);
- touches a subsystem with a handbook → update `docs/handbook/<x>.md`
  _with_ the code (frontmatter `tracks:` lists the files it follows);
- introduces an integration or E2E scenario → update
  `docs/tests/integration-tests.md` or `docs/tests/e2e-tests.md`;
- changes the workflow itself → update this file.

The pre-commit hook does not check doc-code coherence. Drift is detected
with the `/drift` skill and the doc audit with `/doc-audit`; both are run at
the end of each build phase (the "cycle-end" pass).
