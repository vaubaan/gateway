---
title: Coding workflow
status: current
date: 2026-05-22
last_synced: 2026-10-13
tracks:
  - .github/
  - package.json
  - tsconfig.base.json
  - vitest.config.ts
  - apps/gateway/tests/e2e/v5/playwright.config.ts
  - eslint.config.js
  - .husky/pre-commit
  - CONTRIBUTING.md
  - deploy/docker/Dockerfile
  - deploy/docker/smoke.sh
---

# Coding workflow

How the repository is laid out, what runs locally and in CI, how branches
and releases work during the v5 build. The v4 SaaS workflow (Vercel
preview deploys, Supabase migrations) is gone with P0.1; see the ADR
[repository-layout-and-contribution-workflow](../decisions/repository-layout-and-contribution-workflow.md).

## Layout

The repository is an npm workspaces monorepo with three roots:

```
apps/gateway/            the deployable: server + Next.js UI       @vaubaan/gateway-app (private)
packages/shared/         risk types, api-key, data-model            @vaubaan/shared
packages/policy-engine/  slice DSL, matcher, evaluator, runtime     @vaubaan/policy-engine
packages/plugin-sdk/     plugin contract, registry, test kit        @vaubaan/plugin-sdk
packages/gateway-core/   pipeline, decisions, refusals, audit       @vaubaan/gateway-core
plugins/<provider>/      one provider plugin per folder             @vaubaan/plugin-<provider>
plugins/_template/       scaffold for a new plugin                  @vaubaan/plugin-template
deploy/                  Dockerfile, compose, Caddy, example config
docs/                    spec, decisions, handbook, tests, workflow
scripts/                 gen-master-key.mjs (npm run gen-master-key)
```

- `workspaces`: `apps/*`, `packages/*`, `plugins/*`. A new library goes
  under `packages/`, a new provider under `plugins/<provider-id>` named
  `@vaubaan/plugin-<provider-id>`, a new deployable under `apps/`.
- Every workspace has its own `tsconfig.json` extending
  `../../tsconfig.base.json` and a `type-check` script; `npm run
type-check` at the root fans out to all of them.
- Root files for contributors: `README.md`, `LICENSE` (Apache-2.0),
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`,
  three issue forms under `.github/ISSUE_TEMPLATE/` (`bug_report`,
  `feature_request`, `plugin_request`; blank issues disabled) and
  `.github/PULL_REQUEST_TEMPLATE.md` (checklist: spec, ADR, handbook, tests,
  English, no hard-coded configuration, `npm run ci`, CHANGELOG).
- Historical v4 documents are marked `status: legacy` or moved to
  `docs/**/legacy/` (ADR
  [legacy-status-of-v4-adrs-and-handbooks](../decisions/legacy-status-of-v4-adrs-and-handbooks.md)).
- Nothing in the repository depends on Vercel or Supabase: the v4
  application code and its `@supabase/*` dependencies were deleted with
  P1.6.

## TypeScript and lint baseline

- `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `useUnknownInCatchVariables`, ES2022, bundler resolution,
  `allowImportingTsExtensions` (packages import `./x.ts` directly).
- `eslint.config.js` (flat config, ESLint 9): `recommendedTypeChecked`,
  `no-floating-promises` and `no-misused-promises` as errors,
  `consistent-type-imports` (inline), `no-console` as a warning outside
  `scripts/`; `--max-warnings=0` makes warnings fail. Config files, Next
  outputs and the agent worktrees under `.claude/worktrees/` are ignored.
- Prettier formats everything (`npm run format`, `format:check`).

## Scripts

| Script                            | What it does                                                        |
| --------------------------------- | ------------------------------------------------------------------- |
| `npm run ci`                      | type-check, lint, format:check, build, test — the exact CI gate     |
| `npm run type-check`              | `tsc --noEmit` in every workspace                                   |
| `npm run lint` / `lint:fix`       | ESLint over the repository                                          |
| `npm run format` / `format:check` | Prettier write / check                                              |
| `npm run build`                   | every workspace `build` (today: `next build` of `apps/gateway`)     |
| `npm run test` / `test:watch`     | Vitest, whole suite                                                 |
| `npm run test:e2e`                | builds, then Playwright on the ephemeral instance (CI job `e2e`)    |
| `npm run dev`                     | `next dev` of `apps/gateway`                                        |
| `npm run gen-master-key`          | prints a fresh 32-byte base64 master key                            |
| `npm run docker:build`            | builds `deploy/docker/Dockerfile` as `vaubaan-gateway:local`        |
| `npm run docker:smoke`            | runs `deploy/docker/smoke.sh` against that image                    |
| `prepare`                         | installs the husky hook (`husky \|\| true`, never fails an install) |

Tests: Vitest collects `apps/*/tests/{unit,integration}`,
`packages/*/tests/{unit,integration}`, `plugins/*/tests/unit` (`.test.ts`
and `.test.tsx`) and co-located `*.test.ts` under `apps/*/src` and
`packages/*/src`; `apps/*/tests/e2e/**` is excluded and belongs to
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

Triggers: push and pull request to `main` and `v5`, plus
`workflow_dispatch`. One concurrency group per ref with
`cancel-in-progress`; `permissions: contents: read`. Single Linux runner,
Node 22, `npm install --no-audit --no-fund` (not `npm ci`, because
`@sbw-vaubaan/harness` is an optional dependency from a private registry
that is skipped without `NPM_READ_TOKEN`; see `CONTRIBUTING.md`).

```yaml
jobs:
  check:
    - npm run type-check
    - npm run lint
    - npm run format:check
    - npm run build # next build (Turbopack); standalone output
    - npm run test # vitest run
  e2e: # needs: check; timeout 20 min
    - npx playwright install --with-deps chromium
    - npm run test:e2e:v5 # next build, then Playwright on the ephemeral instance
    - on failure: upload test-results/v5 (traces, screenshots) for 7 days
  docker: # needs: check
    - docker/build-push-action (deploy/docker/Dockerfile, push: false, load: true,
      GitHub Actions layer cache, build-arg GIT_COMMIT_SHA=${{ github.sha }})
    - deploy/docker/smoke.sh vaubaan-gateway:ci
```

The `docker` job builds the single gateway image and runs the container
smoke test described in [`docs/tests/e2e-tests.md`](../tests/e2e-tests.md)
(fail-fast exit naming the key, https rule, `/healthz`, secret redaction,
native addons, non-root). The image is not published; that is the release
pipeline's job (P3.2). No Node matrix, no cross-OS.

The `e2e` job (P1.9) runs the browser tests of
`apps/gateway/tests/e2e/v5/` — the cutover smoke among them — against an
ephemeral instance: the built app on the real composition root with the
`:memory:` store, a simulated identity provider and a mocked provider. It
needs no secret and reaches no network besides the Chromium download. It is
not part of `npm run ci`, which stays the `check` job's gate; run it locally
with `npm run test:e2e:v5` (after `npx playwright install chromium` once).
The cutover acceptance scenario itself is manual and is never run by CI
([`docs/tests/e2e-tests.md`](../tests/e2e-tests.md)).

## Docker image

`deploy/docker/Dockerfile` is a multi-stage build (`manifests` → `deps` →
`build` → `runner`) on `node:22-bookworm-slim` (glibc, for the prebuilt
`argon2` and `better-sqlite3` addons). The runner stage copies the Next.js
standalone output, runs as uid 10001, exposes `PORT` (3000), declares the
`/data` volume and a `HEALTHCHECK` on `/healthz`. Build arguments:
`NODE_VERSION`, `GIT_COMMIT_SHA`. `.dockerignore` keeps `.git`, docs, test
artefacts and every `.env*` file out of the build context. Operator
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

The package version is `2.0.0-alpha.0` (`package.json`) and follows
semantic versioning; the public product name is v2 while the repository's
plan calls the same work v5. `CHANGELOG.md` keeps an `Unreleased` section
in the Keep a Changelog format; tags are `v2.x.y`. Image publication to a
registry and the release pipeline are feature P3.2; until then no image is
published and nothing on `main` or `v5` is deployable.

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
