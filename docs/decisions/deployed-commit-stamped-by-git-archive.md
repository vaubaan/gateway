---
title: Deployed commit — stamped by git archive, never by a build argument
status: accepted
date: 2026-10-16
extends:
  - docker-image-and-config-format
  - railway-deployment-and-privilege-dropping-entrypoint
---

# Deployed commit — stamped by git archive, never by a build argument

> Fix of the dogfood instance of 2026-10-16. Handbooks:
> [configuration](../handbook/configuration.md) (`/healthz`, "Framework"),
> deploy guides [README](../../deploy/README.md) and
> [railway](../../deploy/railway.md) §5, workflow
> [coding-workflow](../workflow/coding-workflow.md).

## Context

`/healthz` and the footer of the interface report the commit of the build.
`next.config.ts` read it from the build argument `GIT_COMMIT_SHA`
(`deploy/docker/Dockerfile`: `ARG` then `ENV`), falling back to
`git rev-parse`. The CI passed `github.sha`. On Railway the procedure of
`deploy/railway.md` §5 uploads a `git archive` (no `.git`), so the commit
had to come from somewhere else: a service variable `GIT_COMMIT_SHA`, set
by hand once, which Railway hands to the build as the matching `ARG`. It
stayed at an old value across several `railway up`: `/healthz` claimed a
commit that was not deployed. A stamp that a person must remember to update
is wrong by construction.

## Decision

1. **The commit is written by `git archive` itself.** The tracked file
   `apps/gateway/build-commit.txt` holds `$Format:%H$`, and `.gitattributes`
   marks it `export-subst`: every `git archive` of a commit (the Railway
   procedure, a GitHub source tarball) replaces the placeholder with the
   full id of the archived commit. Nothing to remember, nothing to set.
2. **`next.config.ts` believes, in order:** the stamp (40 lower-case hex
   characters, shortened to 7), else the checkout's own `HEAD` when the
   build runs in a git checkout (with `-dirty` when tracked files differ
   from it), else **`unknown`**. It reads no environment variable for the
   commit; the logic is `resolveCommitSha` / `commitFromStamp`, exported and
   tested.
3. **No build argument.** The Dockerfile declares no `GIT_COMMIT_SHA`
   (`ARG` or `ENV`), so no platform variable can reach the build under that
   name. The CI and release jobs, which build the image from a checkout, run
   `scripts/stamp-commit.sh` before the build: it extracts the file from
   `git archive HEAD`, the same mechanism as a deployment, and fails if the
   result is not a commit id.

## Consequences

- A tree deployed from `git archive` of commit C reports C, whatever
  variables the platform holds. An image built from a working copy that was
  not stamped (`npm run docker:build` locally) reports `unknown`, as it did
  before with the default argument; a local `next build` reports the
  checkout's HEAD, marked `-dirty` when it does not match.
- The `GIT_COMMIT_SHA` service variable of an existing Railway service is
  now ignored; `deploy/railway.md` says to delete it.
- `scripts/stamp-commit.sh` modifies a tracked file: it is for throw-away
  checkouts (CI runners), never a developer's working copy.
- The release smoke test (`SMOKE_EXPECT_COMMIT`) still checks the commit
  the image answers, now produced by the stamp.

## Rejected alternatives

- **Keep the build argument, document "update the variable".** The failure
  was precisely a variable nobody updated; a procedure step does not make it
  truthful by construction.
- **A deployment script (`scripts/deploy-railway.mjs`) that archives, writes
  the commit and runs `railway up`.** It works only when that script is
  used; `export-subst` makes every archive correct, the script's and a
  hand-typed one alike, with no code to maintain. The manual procedure of
  §5 stays short.
- **Railway's `RAILWAY_GIT_COMMIT_SHA`.** Set only for deployments from a
  connected repository, which the guide disables (verified builds are
  uploaded); and it would tie the gateway to one platform.
- **Read the commit at boot from a file.** Equivalent in truthfulness, but
  the version and build time are already frozen at build time; one moment
  for all stamps keeps the footer, `/healthz` and the build id consistent.
