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
> half (image publishing, GitHub releases) is decided in
> "Amendment 2026-10-13 — Release" at the end of this document (feature P3.2).

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
  a Phase 3 release decision; the layout does not depend on it. (Decided:
  not published for v2 — amendment "Release", R11.)
- Plugins import only `@vaubaan/shared`, `@vaubaan/policy-engine` and, from
  P0.2, `@vaubaan/plugin-sdk`. A plugin never imports the application.

### Licence and version

- `"license": "Apache-2.0"`, full text in `LICENSE`, copyright "2026
  Vaubaan contributors".
- Root version `2.0.0-alpha.0`. The public product name is **v2**; the
  internal plan number **v5** appears only in ADR and plan prose. Release
  tags are `v2.x.y` (semver). The last SaaS release is tag `v4-final`.
  (What the version promises, pre-releases and who tags: amendment
  "Release", R1 to R3, R9, R10.)
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
  the release pipeline (P3.2; amendment "Release", R4 to R8). How `v5`
  reaches `main`: R13.

### Private tooling dependency

> Replaced on 2026-10-14 by
> [the public harness dev dependency](./public-harness-dev-dependency.md):
> the harness is now `@vaubaan/harness` on the public registry.

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

## Amendment 2026-10-13 — Release

Refines "Licence and version", "Workspaces and naming" (publication) and
"Branch model and pull requests" (image publishing); changes none of the
other decisions. Implemented by feature P3.2. The procedure is in
[`docs/workflow/coding-workflow.md`](../workflow/coding-workflow.md#release).

### Context

The decision above fixed semver, the `v2.x.y` tags, Keep a Changelog and
GHCR as the registry ([[docker-image-and-config-format]]), and left the rest
to Phase 3: what a tag triggers, what the version number promises, how
pre-releases are named, how the ten in-tree plugins — each with its own
version, reported by telemetry — relate to the gateway's, who refreshes the
pinned base image, and how the `v5` integration branch reaches `main`.

Facts that constrain the answer:

- The version already had one reader (`next.config.ts` freezes the root
  `package.json` version into the bundle for `/healthz`), but nothing tied a
  tag to it, and the interface did not show it.
- The image depends on two native addons. `argon2` ships prebuilt binaries
  for `linux-x64` and `linux-arm64` (glibc and musl) inside its package;
  `better-sqlite3` publishes prebuilt `linux-x64` and `linux-arm64` binaries
  for the Node ABI of the base image; the pinned `node:22-bookworm-slim`
  index has both platforms. Checked on 2026-10-13 (argon2 0.41.1,
  better-sqlite3 12.11.1, Node ABI 127).
- GitHub offers `ubuntu-24.04-arm` hosted runners to public and private
  repositories. Artifact attestations are available to public repositories
  on every plan, and to private ones on Enterprise Cloud only. The
  repository is private today and becomes public with v2.
- The product is deployed on premises by people who did not build it: the
  image is the artefact they trust, so its origin must be checkable.

### Decision

**R1 — One version, in the root `package.json`.** Nothing else states the
gateway version. The build stamps it; `/healthz`, the footer of every page,
the MCP server info and the telemetry `gateway_version` read that stamp. A
structural test holds the stamp and the manifest together. Workspace
packages keep `0.0.0`.

**R2 — A tag is a claim the pipeline verifies, not a command it obeys.**
`release.yml` runs on the push of a tag `v2.*.*` and refuses it unless the
tag names the version of `package.json`, is the highest release so far, has
a dated section in `CHANGELOG.md` (not `Unreleased`, not empty), and its
commit is on `main` — or, for a pre-release, on `v5` until the cutover.

**R3 — Preparing a release is a script; tagging is a human act.**
`npm run release:prepare -- <version>` cuts the changelog section and sets
the version, and prints the tag command. It creates no commit and no tag.
No workflow, script or agent creates or pushes a release tag.

**R4 — The gates are CI itself.** `release.yml` calls `ci.yml`
(`workflow_call`) instead of copying its jobs: a gate added to CI is a gate
of the release without a second edit.

**R5 — One image, two architectures, built natively.** `linux/amd64` and
`linux/arm64`, each built and smoke-tested on a runner of its own
architecture — no emulation. The smoke test loads both native addons on
both, at every release.

**R6 — Tested before tagged.** Each architecture is pushed by digest,
without a tag, only after the gates and the local smoke test pass; the
pushed digest is pulled back and smoke-tested again; only then are the two
digests assembled under `<version>`. A version tag never moves: the
pipeline keeps an existing one that holds the same images and refuses any
other. A final release also moves `<major>.<minor>` and `latest`, after the
attestation of R7 exists. Because these two only move forward, a tag older
than an existing release is refused: one line of releases, no maintenance
branch.

**R7 — Provenance and bill of materials.** The published digest gets a
signed build-provenance attestation (`actions/attest`, Sigstore; stored on
GitHub and in the registry), verifiable with `gh attestation verify`. Each
platform image carries BuildKit's SBOM and provenance (`mode=max`), and the
GitHub release carries one SPDX file per architecture. Actions are pinned
by commit.

**R8 — Least privilege, and a dry run that cannot publish.** No permission
at the workflow level. The jobs that plan, gate and build hold
`contents: read`. The three that write (`push`, `publish`, `release`) run
only on a tag push; a manual run is a dry run in which they are skipped —
it holds no credential that could publish.

**R9 — What the version promises.** Semver over four named surfaces —
configuration keys, refusal codes, the plugin SDK contract, catalog ids
(provider ids, tool names, preset ids; risk ids never change at all) — plus
the doors' paths and credentials, `/healthz` and the image's promises to its
host. The interface, log texts and the workspace-internal packages are not
part of the contract. A fix that refuses what was wrongly allowed is not a
breaking change; it ships under `### Security`.

**R10 — Pre-releases.** `-alpha.N`, `-beta.N`, `-rc.N` and nothing else.
They publish their own version tag only and promise no compatibility with
one another.

**R11 — Plugins keep their own versions; the gateway bundles them.** D9 of
[[plugin-contract-and-credential-spec]] governs a plugin's version. A
plugin patch needs a gateway patch at least, a plugin minor a gateway
minor, a plugin major a gateway major — except a stricter classification
that is a security fix (R9). The gateway version does not mirror any
plugin's. Nothing is published to npm: the question "Workspaces and naming"
left to Phase 3 is answered **no** for v2; the image is the only artefact.

**R12 — Base images are refreshed by hand.** The digests of the Node and
Caddy images are bumped, version and digest together, before every release
and on a security release of Node or Debian.

**R13 — The cutover of `v5` to `main` is manual and Renaud's alone.** One
pull request `v5` → `main`, merged with a merge commit (the exception to
the squash rule), by Renaud. No branch, workflow or agent does it. `v5`
lives until `2.0.0` is out.

### Consequences

- `ci.yml` gains `workflow_call`, and its concurrency group includes
  `github.workflow`, so a release and the CI run of the same ref do not
  cancel each other.
- `deploy/docker/smoke.sh` accepts three optional expectations (version,
  commit, architecture); without them it behaves as before.
- A release builds and smoke-tests the amd64 image three times (CI's
  `docker` job, `image`, and `push` from the cache of `image`) and the
  arm64 image twice. Accepted: releases are rare and the redundancy is what
  makes "tested before tagged" true.
- `image` reads no cache, so a release never reuses a layer of another run;
  it writes one cache scope per run and architecture, which counts against
  the repository's Actions cache quota until GitHub evicts it.
- While the repository is private and not on Enterprise Cloud, `publish`
  fails at the attestation: the image is in the registry under its version
  tag, `latest` has not moved and no GitHub release is created. The first
  real release waits for the repository to be public. The dry run is
  unaffected — but GitHub only offers a manual run for a workflow file on
  the default branch, so there is no dry run before the cutover (R13).
- A run that fails after `push` leaves untagged digests in GHCR. They are
  harmless and unreferenced; nothing cleans them up.
- The step that assembles and tags the image is a shell script
  (`scripts/release-image-index.sh`) with no automated test: it needs a
  registry. It was rehearsed against a local one.
- Without a maintenance branch, a fix for 2.0 after 2.1 exists means
  upgrading to 2.1.x. Supporting an older minor would need its own decision
  (and `latest` could no longer be "the tag that was just pushed").
- Protecting `v2.*` tags and requiring an approval before the publishing
  jobs are repository settings; they are recommended, and deliberately not
  set by this feature.
- The pinned base digests and the pinned actions age silently. Nothing
  proposes their bumps; R12 is a discipline, not a mechanism.

### Rejected alternatives

- **Tag from the pipeline (release-please, semantic-release, a "release"
  button that tags).** Automates the one step that must stay a decision:
  what is published under the project's name. It would also give a workflow
  `contents: write` on every merge. Rejected; the script prepares, a
  maintainer tags.
- **Derive the version from the tag at build time** (`git describe`, or a
  build argument). Two sources — the manifest and the tag — that can
  disagree, and a local or CI build that reports nothing useful. Rejected;
  the manifest is the source and the tag must match it.
- **Copy CI's jobs into `release.yml`.** No dependency between the two
  files, but the copies drift, and the day they do a release passes less
  than a pull request. Rejected.
- **One runner, QEMU emulation for `arm64`.** One job instead of a matrix
  and a merge, but an emulated `next build` is several times slower and the
  smoke test would exercise an emulated CPU. Rejected while native runners
  are available; it is the fallback if they are not.
- **Ship `amd64` only.** Simplest, and was the fallback had an addon lacked
  an `arm64` binary. Both have one, and ARM hosts are common on premises
  and on laptops. Rejected.
- **Build once, tag immediately, test after.** The usual shape of the
  docker actions' quick start. A failing image would be reachable under its
  version tag, or under `latest`, until someone noticed. Rejected.
- **One job with every permission and `if:` on the pushing steps.** Fewer
  lines and a single build, but a dry run would hold `packages: write` and
  rely on conditions to not use it. Rejected for R8.
- **Hand the built image from job to job as an OCI archive** so that the
  bytes pushed are the bytes tested, with no second build. Needs a second
  tool to push an archive by digest and loses BuildKit's in-registry
  attestations. Rejected; smoke-testing the pushed digest gives the same
  guarantee with the tools already in use.
- **Cosign signatures managed by the project.** A key, or keyless signing
  wired by hand, for what `actions/attest` provides with GitHub's identity
  and one CLI command to verify. Rejected for now.
- **Lock plugin versions to the gateway's.** One number to read, but D9
  would lose its meaning (a risk added to one plugin would bump ten) and
  telemetry's `plugin_version` would stop saying anything about a plugin.
  Rejected.
- **Bump the version to the next `-alpha.0` after each release.** Tells a
  development build from a release by its version; adds a commit per
  release and a version that names something that may never exist. The
  commit stamp already tells builds apart. Rejected.

## Amendment 2026-10-18 — Release from a private repository

Refines R5, R6, R7 and R8 of the amendment "Release" above and replaces
its consequence "While the repository is private and not on Enterprise
Cloud, `publish` fails at the attestation … The first real release waits
for the repository to be public." Procedure:
[`docs/workflow/coding-workflow.md`](../workflow/coding-workflow.md#on-a-private-repository).

### Context

The first release (`2.0.0-alpha.1`) is due while the repository is still
private, on an organization plan that includes neither of two things the
pipeline relies on. GitHub gives the `ubuntu-24.04-arm` hosted runner to
public repositories; a private repository gets it with a plan that includes
it, and a job that asks for it otherwise is queued and never starts — the
run does not fail, it waits. Artifact attestations (`actions/attest`) exist
for public repositories on every plan and for private ones on GitHub
Enterprise Cloud only; there the step fails. The 2026-10-13 amendment knew
both facts, and chose to let `publish` fail: the image would exist under its
version tag, without aliases and without a GitHub release, and the first
real release would wait for the repository to be public. Two things changed
that choice: the release is wanted now, and with a static two-architecture
matrix the `image` job of a private repository does not fail at all — it
hangs on the arm64 runner, so even the dry run never finishes.

The same situation is the ordinary one for anybody who forks the repository
and keeps the fork private to release their own build. The pipeline is part
of what they fork; it has to work there, and to say what it could not do.

### Decision

**R14 — The plan decides what the repository can publish, once, and says
it.** `plan` reads `github.event.repository.private` and
`scripts/release-lib.mjs` (`publicationScope`) turns it into the matrix of
architectures and whether an attestation is signed. A public repository
gets the whole plan of the amendment "Release", unchanged. A private one
gets `linux/amd64` only and no attestation; everything else — gates, smoke
tests, image scan, SBOMs, image index, version tag, GitHub release — is the
same. The decision is written three times where a reader looks: the
summary of `plan`, the summary of `publish` under the digest it tagged, and
a paragraph "Built from a private repository" in the release notes, each
naming the two items left out and why. Nothing is skipped quietly.

**R15 — A smaller plan is never a smaller result by accident.**
`scripts/release-image-index.sh` is told the planned architectures and
refuses a set of pushed digests that does not match them exactly, so a
`push` job that did not run cannot leave a one-architecture image under a
two-architecture plan. On a public repository a missing or unverifiable
attestation still fails `publish` and `release` (R7, D8 of
[[supply-chain-and-ci-security-checks]]); the two attestation steps are
skipped only on the plan's explicit decision, never on their own failure.

**R16 — `latest` moves on a private repository.** R6 said `latest` never
names an image without an attestation. On a private repository no image can
have one, and the rule would mean "no `latest` ever" for a self-hoster's
fork. The rule's purpose — an attestation step that failed or was skipped
must not be masked by a moving alias — is kept by R15: the aliases of a
final release move when the attestation is verified, or when the plan
decided there is none. They still never move after a failed attestation.

### Consequences

- The `image` and `push` jobs take their matrix from `plan`
  (`fromJSON`); the static matrix leaves `release.yml`. The runner labels
  and the Node architecture of each entry live in `ARCHITECTURES` of
  `scripts/release-lib.mjs`, tested.
- `release-plan.mjs` gains `--private-repository <true|false>` and five
  outputs (`matrix`, `architectures`, `platforms`, `attest`, `left_out`);
  `release-image-index.sh create` gains a fourth argument. The scripts'
  tests cover the scope and the outputs; the index script still has no
  automated test.
- A release published from a private repository has no attestation to
  verify: the operator pins its digest and relies on the SBOM and on the
  BuildKit provenance inside the image, and `deploy/README.md` says so. The
  release notes of such a release carry no verify command.
- The day the repository becomes public, nothing changes in the files: the
  next tag publishes both architectures with an attestation. The releases
  cut before it stay as they are — `amd64` only, unattested — and their
  notes say so.
- An `arm64` host cannot run a release cut from a private repository. For
  a fork, the owner pays for the arm runner, emulates (rejected below for
  the project, not for a fork), or makes the fork public.

### Rejected alternatives

- **Keep failing at the attestation and wait for the repository to be
  public** (the 2026-10-13 choice). Blocks the first release on a
  decision — going public — that has its own calendar, and leaves a fork
  that stays private with a pipeline that hangs. Rejected.
- **Emulate `arm64` with QEMU on the amd64 runner when the arm runner is
  unavailable.** Keeps two architectures everywhere; but an emulated
  `next build` takes several times longer than the job timeout allows
  comfortably, and the smoke test would load the native addons on an
  emulated CPU, which is not what "tested before tagged" means. Rejected;
  a fork that needs `arm64` can add it.
- **Sign with `cosign` keyless on a private repository.** Sigstore's public
  instance signs for any GitHub workflow identity, private repositories
  included, and `cosign` verifies it. But it writes the repository's
  identity and the digest to a public transparency log for a repository
  that is private, needs a second verification path in the documentation,
  and would be dropped the day `actions/attest` works. Rejected for now.
- **A repository variable or a workflow input instead of
  `github.event.repository.private`.** Lets a private repository on a plan
  that has the arm runner opt back in, at the price of a setting that can be
  wrong in both directions — a public repository told it is private ships
  less than it could, silently. The event field cannot be wrong. Rejected;
  the opt-in can be added the day somebody needs it.
- **Silently skip: `continue-on-error` on the attestation, `if:` on the
  arm64 entries.** Fewer lines and no new outputs, but a release page that
  names an attestation command that fails, and an operator who learns from
  `docker pull` that there is no `arm64` image. Rejected.
