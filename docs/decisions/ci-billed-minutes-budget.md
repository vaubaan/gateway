---
title: CI is budgeted in billed minutes — one gate job, no run on main, browser tests on demand
status: accepted
date: 2026-10-26
author: Renaud Pelissier (product owner), drafted with Claude
extends:
  - supply-chain-and-ci-security-checks
  - repository-layout-and-contribution-workflow
---

# CI is budgeted in billed minutes — one gate job, no run on main, browser tests on demand

> Product owner's decision of 2026-10-26 (points 1 to 5 below, "fais tout").
> Procedure: [coding-workflow](../workflow/coding-workflow.md), "CI",
> "Dependency updates", "Branches and pull requests", "Local gate".

## Context

The repository is private, on GitHub's free plan for organisations: 2,000
hosted-runner minutes a month, then nothing unless a budget is set. On
2026-10-26 at about 13:40 UTC the month's minutes were spent: every job of
every run failed in four seconds without a step, on every branch, and the
release pipeline (which runs on the same minutes) could not have published.

The tests are not slow. The cost came from the shape of the pipeline:

- **GitHub bills every job rounded up to the next minute.** A pull request
  ran ten jobs in parallel (`scope`, `audit`, `secrets`, `sast`, `check`,
  `lint`, three `test` shards, `e2e`): most take seconds and each counted at
  least a minute, about eighteen to twenty billed minutes per run.
- **Every pull request was checked twice or more**: once per push to it,
  then once more on `main` after the squash merge, on the very tree the pull
  request had checked when it was up to date.
- **The browser tests** (about five billed minutes) ran on every push to
  `main` and on every pull request touching a page or a plugin.
- **Dependabot** opened up to five pull requests a week for npm, plus the
  image, Caddy and the actions, each with its own runs.
- Agents open pull requests and push to them several times; each push is a
  full run.

About sixty billed minutes per pull request: the budget lasted three weeks.

## Decision

1. **One gate job, in series.** `ci.yml`'s job `audit` runs, cheapest and
   most decisive first: scope, dependency audit, lockfile gate, actionlint,
   secret scan, install and registry signatures, type-check, format, website
   build, lint, every Vitest test (no shards), Semgrep. One billed rounding
   instead of ten; a few minutes more of wall time. The name `audit` is kept
   (the dependency audit's test reads it, and it is the gate).
2. **No CI run on a push to `main` or `v5`.** Pull requests are squash merged;
   a pull request merged up to date is exactly the tree it checked. What a
   merge of a stale pull request could break is caught by the weekly run and,
   at the latest, by the release gates.
3. **Browser tests on demand.** `e2e` runs weekly, on a manual run, in the
   release gates, and on a pull request only when it carries the label
   `e2e`. The gate leaves a notice on a pull request that changes what the
   browser shows (`scripts/ci-scope.sh`, `surface=true`) without the label.
   The local gate of such a change includes `npm run test:e2e:v5`.
4. **Nothing on a draft.** A draft pull request runs no CI; "Ready for
   review" starts the run. A pull request is opened when it is ready, and the
   fixes of a review round are pushed together.
5. **Dependabot in two npm pull requests a week at most.** Every minor and
   patch together, every major together (a major only once it is thirty days
   old); the base image, Caddy and the actions once a month. Security updates
   are not delayed by the schedule, and the dependency audit of every run
   fails on an advisory meanwhile.
6. **The weekly run checks everything** on the default branch: `audit` over
   every file (no ESLint cache), `e2e`, and `docker` with the image scan.

The `node_modules` cache of `.github/actions/setup` is keyed by the exact
Node version, not a hand-written major: the native addons are built for the
ABI of the Node that installed them (the key said `node22` after the move to
Node 26, which would have restored addons built for the wrong ABI).

## Consequences

- A pull request costs about ten billed minutes per ready push (measured on
  the first run, #123: 9 min 49 s), fifteen with the label `e2e`; nothing on
  `main`. About 10 to 20 minutes per pull request instead of about 60: the
  free minutes cover the current pace with room, and a paid budget stays a
  safety net, not a running cost.
- Wall time of a pull request run grows from about five to about ten
  minutes: the steps run in series, the whole Vitest suite on one runner.
- A browser regression in a change merged without the label is found by the
  weekly run or by the release gates, never in a release; the label, the
  notice and the local gate make it rare.
- `main` has no fresh caches between weekly runs: a pull request restores
  the caches of the last weekly run (results, never verdicts), so the first
  run of the week may check more files.
- The gateway's GitHub tools cannot mark a draft ready: an agent opens a
  ready pull request once its local gate is green, rather than a draft.
- `secrets.yml` stays: one billed minute per push of a work branch, the price
  of finding a pushed credential before it is merged.

## Rejected alternatives

- **Keep the parallel jobs and only raise the budget.** Pays for the
  rounding of jobs that take seconds; the owner asked not to rely on the
  budget once this is done.
- **A self-hosted runner on the owner's VPS.** Free minutes and faster, but a
  machine to keep patched that runs the code of every pull request, Dependabot
  and agent branches included, next to other workloads. Open again if the
  repository stays private and the pace grows.
- **Make the repository public now.** Unlimited free minutes, but publication
  is a separate decision with its own checklist (branch protection, history
  review).
- **Run CI on `main` and skip it on pull requests.** Finds a failure after
  the merge, on the shared branch, which is the failure mode CI exists to
  prevent.
- **Browser tests on every pull request that touches the surface
  (unchanged).** The rule that let a red `main` happen on 2026-10-18 is now
  covered by the notice, the local gate and the weekly run, at a fraction of
  the cost.
