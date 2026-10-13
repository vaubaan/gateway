---
title: Dependency audit gate — `npm audit --omit=dev` against a reviewed, dated allowlist
status: accepted
date: 2026-10-13
extends:
  - repository-layout-and-contribution-workflow
---

# Dependency audit gate — `npm audit --omit=dev` against a reviewed, dated allowlist

> P3.4. Procedure: [coding-workflow](../workflow/coding-workflow.md),
> "Dependency audit".

## Context

The instance holds a company's provider credentials. Its dependency tree was
installed with `--no-audit` everywhere and nothing looked at advisories. The
first run of the gate found three: one fixable by a lockfile update
(`source-map-js`, done), two reached only through an optional private
development tool.

The CI workflow is also the gate of the release pipeline (`workflow_call`),
so whatever is added there stands in front of every release.

## Decision

A CI job `audit` runs `node scripts/audit-gate.mjs`:

- `npm audit --omit=dev --json`, on the lockfile, nothing installed;
- advisories of severity `moderate` and above fail the job unless
  `.github/audit-allowlist.json` names them;
- an allowlist entry is one GHSA id for one package, with a `reason`, the day
  it was `reviewed` and a `review_by` date at most about a quarter later;
  after that date the entry no longer covers the advisory and the job fails;
- **a registry that does not answer is not an advisory**: four attempts with
  growing pauses, then a warning annotation and success. The two are told
  apart by what `npm audit` printed, never by its exit code;
- an invalid allowlist or an unreadable output fails with its own exit code.

## Consequences

- A new advisory in a production dependency blocks merges and releases until
  somebody upgrades or reviews it. That is the intent.
- A lapsed review also blocks, on a calendar date. The cadence is therefore a
  duty: the workflow handbook says to run the gate by hand before a release,
  and entries are dated a quarter out.
- During a registry outage a release can go out unaudited by that run. The
  warning says so; the previous run on the same lockfile was audited.
- `low` and `info` advisories are listed and do not fail.

## Rejected alternatives

- **`npm audit --audit-level=high` as the job.** No allowlist: the first
  unfixable advisory in a build-time dependency turns the job off for good,
  or CI red for good.
- **An allowlist without dates.** A mute. Entries outlive the reason they
  were written for.
- **Failing on a registry error.** The job would gate releases on the
  availability of a third-party endpoint.
- **A third-party action or service** (Dependabot alerts, Snyk, osv-scanner).
  Useful additions; none is a gate that lives in the repository with its
  reasons reviewed like code, and each needs a permission or an account the
  project has not decided on.
