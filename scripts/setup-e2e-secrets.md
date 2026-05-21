---
title: E2E Secrets Setup (operator)
tracks:
  - .github/workflows/e2e-nightly.yml
  - packages/web/tests/e2e/real-clouds/fixtures/env.ts
last_reviewed: 2026-05-21
---

# E2E Secrets Setup (operator-side)

`.github/workflows/e2e-nightly.yml` runs the real-clouds Playwright
suite + the orphan sweeper. Both rely on a dedicated test account on
each provider so prod is never touched. This doc lists every GH
Actions secret the maintainer must configure before the nightly can
exercise the E2E scenarios.

> Each secret name is prefixed `VAUBAN_E2E_…`. GitHub forbids secrets
> starting with `GITHUB_…`, so the GH provider creds are aliased. The
> mapping is encoded as fallbacks inside
> `packages/web/tests/e2e/real-clouds/fixtures/env.ts`.

## Required secrets (13 total)

Configure them at https://github.com/<owner>/<repo>/settings/secrets/actions
(use the `gh secret set NAME` CLI for convenience).

### Supabase (web app runtime)

| Secret                                     | What                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `VAUBAN_E2E_NEXT_PUBLIC_SUPABASE_URL`      | Public URL of the test Supabase project (`https://<ref>.supabase.co`).                         |
| `VAUBAN_E2E_NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon JWT (RLS-enforced, browser-safe).                                                         |
| `VAUBAN_E2E_SUPABASE_SERVICE_ROLE_KEY`     | Server-side service role JWT — used by the harness to create test users + delete orgs cascade. |

These are the same shape as in `packages/web/.env.local` and `Vercel
env vars`, but pointing at the dedicated test project (NOT prod).

In v1 the prod Supabase project (`ynxfyklzqdumtixkdrco`) is also used
for E2E because no separate test project exists yet. When you decide
to provision a separate `cloud-resource-manager-e2e` Supabase project,
swap these three secrets to point at it; the harness needs no code
change.

### Org / shared

| Secret                 | What                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `VAUBAN_E2E_ORG_EMAIL` | Base email (`sbw-vauban-test@dalae.fr`). The harness generates `+e2e-<runUuid>-<role>@…` aliases per test user. |

### GitHub provider (org `sbw-vauban-test`)

| Secret                      | How to obtain                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VAUBAN_E2E_GH_ORG`         | Hard-coded `sbw-vauban-test`.                                                                                                                                                                                                                    |
| `VAUBAN_E2E_GH_ADMIN_TOKEN` | Fine-grained PAT owned by the test account, scoped to org `sbw-vauban-test`, with `repo:admin` + `repo:read` + `repo:write` + `administration:write` (create/delete repos). Generation : https://github.com/settings/personal-access-tokens/new. |

### Vercel provider (team `team_UDjwZoQKYxXGlcWLn4O8HAvA`)

| Secret                         | How to obtain                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `VAUBAN_E2E_VERCEL_TEAM_ID`    | Hard-coded `team_UDjwZoQKYxXGlcWLn4O8HAvA`.                                               |
| `VAUBAN_E2E_VERCEL_TEAM_TOKEN` | Team-scoped token. Generation: https://vercel.com/account/tokens (scope = the test team). |

### Supabase Management API (org `hfuuqvgcqydwkrhbhuqv`)

| Secret                         | How to obtain                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `VAUBAN_E2E_SUPABASE_ORG_SLUG` | Hard-coded `hfuuqvgcqydwkrhbhuqv` (the org slug returned by `GET /v1/organizations`).                              |
| `VAUBAN_E2E_SUPABASE_TOKEN`    | User-wide PAT (`sbp_…`). Generation: https://supabase.com/dashboard/account/tokens, signed in as the test account. |

### Infisical workspace (`vauban-e2e` on `eu.infisical.com`)

| Secret                       | How to obtain                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `VAUBAN_E2E_INFISICAL_URL`   | Hard-coded `eu.infisical.com`.                                                                              |
| `VAUBAN_E2E_INFISICAL_LOGIN` | Email of the test account (`sbw-vauban-test@dalae.fr`).                                                     |
| `VAUBAN_E2E_INFISICAL_PWD`   | Password of that test account. _Not_ the M2M client secret — the harness uses email/password to grab a JWT. |

## How to configure (one-shot)

```bash
# From your shell with the values from .env.test :
gh secret set VAUBAN_E2E_NEXT_PUBLIC_SUPABASE_URL      --body "$NEXT_PUBLIC_SUPABASE_URL"
gh secret set VAUBAN_E2E_NEXT_PUBLIC_SUPABASE_ANON_KEY --body "$NEXT_PUBLIC_SUPABASE_ANON_KEY"
gh secret set VAUBAN_E2E_SUPABASE_SERVICE_ROLE_KEY     --body "$SUPABASE_SERVICE_ROLE_KEY"
gh secret set VAUBAN_E2E_ORG_EMAIL                     --body "$ORG_EMAIL"
gh secret set VAUBAN_E2E_GH_ORG                        --body "$GITHUB_ORG"
gh secret set VAUBAN_E2E_GH_ADMIN_TOKEN                --body "$GITHUB_ORG_ADMIN_TOKEN"
gh secret set VAUBAN_E2E_VERCEL_TEAM_ID                --body "$VERCEL_TEAM_ID"
gh secret set VAUBAN_E2E_VERCEL_TEAM_TOKEN             --body "$VERCEL_TEAM_TOKEN"
gh secret set VAUBAN_E2E_SUPABASE_ORG_SLUG             --body "$SUPABASE_ORG_SLUG"
gh secret set VAUBAN_E2E_SUPABASE_TOKEN                --body "$SUPABASE_TOKEN"
gh secret set VAUBAN_E2E_INFISICAL_URL                 --body "$INFISICAL_URL"
gh secret set VAUBAN_E2E_INFISICAL_LOGIN               --body "$INFISICAL_LOGIN"
gh secret set VAUBAN_E2E_INFISICAL_PWD                 --body "$INFISICAL_PWD"
```

## Validating the setup

1. Trigger the workflow manually with both inputs left on default :
   ```bash
   gh workflow run e2e-nightly.yml
   ```
2. Watch the run in the Actions tab. The `sweeper` job should print
   `sweeper OK`. The `e2e` job should print the playwright report.
3. If a job fails with `Missing E2E env var: VAUBAN_E2E_…`, the
   corresponding secret is missing or empty. The error message names
   the var explicitly.
4. After a green nightly, the GH Actions artifact
   `playwright-report-<run_id>` contains the HTML report (14d
   retention).

## Rotating the test creds

When a PAT expires :

- GitHub : create a new fine-grained PAT, re-run
  `gh secret set VAUBAN_E2E_GH_ADMIN_TOKEN --body "<new>"`. The
  old token is automatically invalidated.
- Vercel / Supabase / Infisical : same drill, replace the secret
  via `gh secret set`.

The harness picks up the new value on the next workflow run — no
code change needed.

## What's NOT in this list

- `CLOUDFLARE_*` : Cloudflare integration is out-of-scope Phase 8
  (no creds in `.env.test`, no E2E scenario covers it).
- `SUPABASE_PROD_*` : the harness must never carry prod creds. If
  you accidentally swap a prod token into one of the secrets above,
  the test would still pass — but it would create + delete real
  prod resources. Audit the names regularly.
