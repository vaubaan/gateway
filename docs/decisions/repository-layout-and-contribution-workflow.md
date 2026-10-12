---
title: Repository layout and contribution workflow for v5
status: accepted
date: 2026-10-13
extends:
  - pivot-v4-to-v5-on-prem-mission-tokens
---

# Repository layout and contribution workflow for v5

> Records as decided the repository shape that the v5 implementation plan
> (§2) proposed, and the contribution workflow an Apache-2.0 repository
> needs. Implemented by feature P0.1 ("repository reshaping"). The release
> half (image publishing, GitHub releases) is refined in Phase 3.

## Context

The pivot ADR [[pivot-v4-to-v5-on-prem-mission-tokens]] and its amendment
"English and standard repository organisation" turn a private, French,
Vercel-plus-Supabase SaaS monorepo into an open source, on-prem product
with third-party plugins. The v4 tree did not fit:

- `packages/web` was the only deployable but sat among libraries; a
  contributor could not tell the application from the packages.
- Provider plugins lived under `packages/providers/*` with the package
  names `@vaubaan/providers-<p>`, a nested workspace glob
  (`packages/providers/*`) and a confusing "providers" word that the spec
  also uses for the upstream services themselves.
- `supabase/` (42 migrations), `vercel.json`, a Supabase migrations
  workflow and operator scripts targeted infrastructure v5 does not have.
- The root had no `LICENSE`, no contribution guide, no code of conduct,
  no security policy, no changelog and no issue or PR templates.
- The root `package.json` declared `"license": "UNLICENSED"` and version
  `0.0.0`, and listed the maintainers' private `@sbw-vaubaan/harness` in
  both `devDependencies` and `optionalDependencies`.

## Decision

### Tree

```
apps/gateway/            the deployable: server + Next.js UI          @vaubaan/gateway-app
packages/shared/         risk types, api-key, data-model               @vaubaan/shared
packages/policy-engine/  slice DSL, matcher, evaluator, runtime        @vaubaan/policy-engine
packages/gateway-core/   ex mcp-gateway: pipeline, decisions, audit    @vaubaan/gateway-core
packages/plugin-sdk/     (P0.2) plugin contract, registry, test kit    @vaubaan/plugin-sdk
packages/telemetry/      (P2.5) report shape + client                  @vaubaan/telemetry
plugins/<provider>/      one provider plugin per folder                @vaubaan/plugin-<provider>
deploy/                  (P0.4) Dockerfile, compose, example config, collector
docs/                    spec, decisions, handbook, tests, workflow, skills
scripts/                 dev-only scripts (empty after P0.1)
```

Root: `README.md`, `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
`SECURITY.md`, `CHANGELOG.md`, `.github/` (CI, issue templates, PR
template), tool configuration (`package.json`, `tsconfig.base.json`,
`eslint.config.js`, `.prettierrc`, `vitest.config.ts`,
`playwright.config.ts`, `.husky/`).

### Workspaces and naming

- npm workspaces, three globs: `apps/*`, `packages/*`, `plugins/*`. No
  pnpm, no yarn, no Turborepo for now.
- `apps/*` are deployables and are `private`. `packages/*` are libraries
  under the `@vaubaan/` scope. `plugins/*` are provider plugins named
  `@vaubaan/plugin-<provider>`; the folder name equals the provider id.
- Packages and plugins stay **workspace-internal** (not published to npm)
  until a third-party plugin exists outside this repository. Publishing is
  a Phase 3 release decision; the layout does not depend on it.
- Plugins import only `@vaubaan/shared`, `@vaubaan/policy-engine` and, from
  P0.2, `@vaubaan/plugin-sdk`. A plugin never imports the application.

### Licence and version

- `"license": "Apache-2.0"`, full text in `LICENSE`, copyright "2026
  Vaubaan contributors".
- Root version `2.0.0-alpha.0`. The public product name is **v2**; the
  internal plan number **v5** appears only in ADR and plan prose. Release
  tags are `v2.x.y` (semver). The last SaaS release is tag `v4-final`.
- `CHANGELOG.md` follows Keep a Changelog; every user-visible change adds
  an entry under `## [Unreleased]`.

### Branch model and pull requests

- `main` is protected; nothing is pushed to it directly.
- Work happens on `feat/<id>-<slug>` (or `fix/*`) branches. During the v5
  build, features merge into the `v5` integration branch (no fast-forward),
  which is merged into `main` at milestones.
- Squash merge of feature branches; Conventional Commits messages.
- Every PR uses `.github/PULL_REQUEST_TEMPLATE.md`: spec touched? ADR?
  handbook? tests? English? no hard-coded configuration? local gate green?
  CHANGELOG entry?
- CI (`.github/workflows/ci.yml`) runs `type-check`, `lint`,
  `format:check`, `build`, `test` on every push and PR to `main` and `v5`;
  the Docker build step is added by P0.4 and image publishing to GHCR by
  the release pipeline (P3.2).

### Private tooling dependency

`@sbw-vaubaan/harness` stays **only** in `optionalDependencies`. It is
served from GitHub Packages through the `@sbw-vaubaan` scope line in
`.npmrc`. Verified at P0.1: a fresh clone with no `NPM_READ_TOKEN`, an
empty npm cache and no user `.npmrc` runs `npm ci` successfully; npm skips
the optional package and all 14 workspaces link. `CONTRIBUTING.md` states
that the harness is not needed to build, test or run the gateway.

### Open points (recorded, not decided)

- **Q17 — agent files.** `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.mcp.json`
  and `.vaubaan/` are gitignored and rendered by the private harness. An
  open source repository needs a committed English `AGENTS.md`. Options:
  commit the rendered files, or fork them out of the harness. Decided
  later (plan §8-Q17); until then they remain untracked.
- **Q18 — `.npmrc` scope.** The `@sbw-vaubaan` registry line and the
  `${NPM_READ_TOKEN}` placeholder remain in the committed `.npmrc`. npm
  tolerates the unset variable for an optional dependency, but the line
  is still a trace of private tooling in a public repository. Options:
  remove the dependency altogether (install the harness globally), move
  the scope to a user-level `.npmrc`, or keep and document. Decided later.

## Consequences

- Imports and dependency names changed everywhere:
  `@vaubaan/web` → `@vaubaan/gateway-app`, `@vaubaan/mcp-gateway` →
  `@vaubaan/gateway-core`, `@vaubaan/providers-<p>` → `@vaubaan/plugin-<p>`.
  Paths changed: `packages/web` → `apps/gateway`, `packages/providers/<p>`
  → `plugins/<p>`. Historical ADRs still cite the old paths; they are
  immutable and now carry a legacy banner
  ([[legacy-status-of-v4-adrs-and-handbooks]]).
- `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js`,
  `.prettierignore` and `.gitignore` know the three roots; adding a
  workspace under an existing root needs no configuration change.
- `supabase/`, `vercel.json`, the Supabase migrations workflow, the v4
  `.env.example` and the Supabase/Vercel scripts are gone; `pg` left the
  root dependencies with them. The SQLite schema arrives with P0.3 under
  `apps/gateway/migrations/`.
- `git mv` preserved history; `git log --follow` works across the move.
- The `scripts/` folder is empty until the dev-only scripts of later
  features (master key generation, dev IdP) land.
- `lint-staged` runs ESLint with `--no-warn-ignored` so that committing a
  configuration file ESLint deliberately ignores does not fail the hook.

## Rejected alternatives

- **Keep `packages/web` as the application.** Cheapest, but it hides the
  single deployable among libraries and keeps a name ("web") that no
  longer describes a process that is also the MCP server, the OAuth
  authorization server and the store owner. Rejected.
- **One flat `packages/` for everything (app, libraries, plugins).**
  Simplest glob, but it mixes three contribution audiences (core
  maintainers, library consumers, plugin authors) in one list and makes
  "which folder do I open to add a provider?" a documentation question
  instead of a visible one. Rejected.
- **One repository per plugin.** The natural end state once third parties
  publish plugins, but today it would multiply CI setups, lose atomic
  changes across the plugin contract and its ten implementations, and
  block the P0.2 SDK extraction. Rejected for now; the `plugins/` folder
  and the `@vaubaan/plugin-<p>` naming keep that door open.
- **Switch to pnpm or Turborepo during the reshape.** Would couple a
  tooling migration with a structural move and make the "no functional
  change" guarantee hard to verify. Rejected; may be revisited in Phase 3.
- **Drop `@sbw-vaubaan/harness` from `package.json` immediately.** The
  maintainers' workflow depends on it and `npm ci` already works without
  the token; the decision is deferred to Q18 with the facts recorded here.
