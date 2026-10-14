---
title: The maintainers' harness is a public dev dependency
status: accepted
date: 2026-10-14
extends:
  - repository-layout-and-contribution-workflow
  - dependency-audit-gate
---

# The maintainers' harness is a public dev dependency

## Context

[repository-layout-and-contribution-workflow](./repository-layout-and-contribution-workflow.md)
kept the maintainers' agent tooling, `@sbw-vaubaan/harness`, **only** in
`optionalDependencies`: it was served from a private GitHub Packages
registry through an `@sbw-vaubaan` line in `.npmrc`, and npm skipped it
without `NPM_READ_TOKEN`. The
[dependency audit gate](./dependency-audit-gate.md) allowlisted two
advisories (`braces`, `sprintf-js`) reached only through that package.

The harness is now open source and published on the public npm registry as
`@vaubaan/harness` (1.4.0). Installing it needs no token.

## Decision

- `@vaubaan/harness` replaces `@sbw-vaubaan/harness` and moves to
  `devDependencies`: it is development tooling, and no longer needs to be
  optional.
- `.npmrc`, `NPM_READ_TOKEN` (local `.env`, CI, the repository secret) and
  the text explaining the skipped optional package are removed.
- The two allowlist entries that existed only because of the private
  package are removed. `npm audit --omit=dev` reports no advisory once the
  harness is a dev dependency.

This replaces the "Private tooling dependency" section of the repository
layout decision; the rest of that decision is unchanged.

## Consequences

- `npm ci` installs the harness everywhere, including CI and the Docker
  `deps` stage. It is not traced into the standalone output, so the image
  does not ship it.
- The audit gate no longer sees the harness's dependency tree, since it
  audits production dependencies only.
- A fresh clone needs no registry configuration.

## Rejected alternatives

### Keep it optional

The optional status only existed to tolerate a missing registry token.
With a public package it would hide install failures for no benefit.

### Keep the allowlist entries

They would match nothing, and their reasons (a private package absent from
CI installs) would no longer be true.
