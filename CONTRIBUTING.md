# Contributing to Vaubaan Gateway

Thanks for your interest. This document is a skeleton for the v5 build
period; it will be completed when the first `v2.0.0` release approaches.

## Prerequisites

- Node.js >= 20 and npm >= 10 (CI runs Node 22).
- Git. No database, no cloud account: the test suite makes no network call.

## Setup and local gate

```bash
npm ci
npm run ci        # type-check + lint + format check + tests + build
```

`npm run ci` is the exact gate CI runs. The pre-commit hook (husky +
lint-staged) only lints and format-checks staged files; run the full gate
before pushing.

The optional dependency `@sbw-vaubaan/harness` is served from a private
registry (`.npmrc` scope `@sbw-vaubaan`). It is **optional**: without
`NPM_READ_TOKEN`, npm skips it and everything else installs and runs. It
only provides the maintainers' agent tooling and is not needed to build,
test or run the gateway.

## Repository layout

```
apps/gateway/            the deployable (server + Next.js UI)   @vaubaan/gateway-app
packages/shared/         shared types and helpers              @vaubaan/shared
packages/policy-engine/  slice DSL, matcher, evaluator         @vaubaan/policy-engine
packages/plugin-sdk/     plugin contract, registry, test kit   @vaubaan/plugin-sdk
packages/gateway-core/   pipeline, decisions, refusals, audit  @vaubaan/gateway-core
plugins/<provider>/      one provider plugin per folder        @vaubaan/plugin-<provider>
plugins/_template/       scaffold for a new plugin             @vaubaan/plugin-template
docs/                    spec, decisions, handbook, tests, workflow
```

npm workspaces: `apps/*`, `packages/*`, `plugins/*`. The layout and its
rationale are recorded in the ADR
[repository-layout-and-contribution-workflow](docs/decisions/repository-layout-and-contribution-workflow.md).

Writing a plugin: start with [`plugins/README.md`](plugins/README.md).

## Doc-first rule

The documentation is not an afterthought; it is part of the change.

1. **Spec** (`docs/spec/`) says _what_ and _why_. A change that alters
   behaviour starts with the spec. Spec changes are discussed before code.
2. **Decisions** (`docs/decisions/`) are ADRs: Context, Decision,
   Consequences, Rejected alternatives. Any non-trivial choice gets one.
   ADRs are immutable; a new one supersedes an old one.
3. **Handbook** (`docs/handbook/`) describes how the code actually works
   today. Its `tracks:` frontmatter lists the files it follows.
4. **Tests** (`docs/tests/`) list the integration and e2e scenarios.
5. **Workflow** (`docs/workflow/coding-workflow.md`) describes CI,
   branches and releases.

The working method for maintainers and coding agents is in `AGENTS.md`
(rendered by the maintainers' tooling; its commit status is an open point
of the layout ADR).

## Language

Everything written from v5 on is in **English**: code, comments, commit
messages, documentation, issues. Older documents in French are marked
`status: legacy` and are not translated.

## Branches and pull requests

- `main` is protected. Work happens on `feat/*` (or `fix/*`) branches.
  During the v5 build, features integrate into the `v5` branch first.
- One feature or fix per PR; squash merge.
- Commit messages follow Conventional Commits (`feat(scope): …`,
  `fix(scope): …`, `docs: …`, `refactor(repo): …`).
- The PR template has the checklist: spec touched? ADR? handbook? tests?
  English? no hard-coded configuration? `npm run ci` green? CHANGELOG?

## Reporting problems

Bugs and feature requests go through the issue templates. Security issues
go through private vulnerability reporting; see [`SECURITY.md`](SECURITY.md).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Contributions are licensed under [Apache-2.0](LICENSE).
