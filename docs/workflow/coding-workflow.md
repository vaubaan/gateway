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
  - playwright.config.ts
  - eslint.config.js
  - .husky/pre-commit
  - CONTRIBUTING.md
  - deploy/docker/Dockerfile
  - deploy/docker/smoke.sh
---

# Coding workflow

> **Transition note (2026-10-13).** The sections below in French describe
> the v4 SaaS workflow (Vercel deploys, Supabase migrations) and are being
> replaced section by section by the v5 plan. The "Layout" and "Local CI
> gate" sections are current. Vercel and Supabase are gone from the
> repository since P0.1; see the ADR
> [repository-layout-and-contribution-workflow](../decisions/repository-layout-and-contribution-workflow.md).

## Layout

The repository is an npm workspaces monorepo with three roots
(ADR [repository-layout-and-contribution-workflow](../decisions/repository-layout-and-contribution-workflow.md)):

```
apps/gateway/            the deployable: server + Next.js UI       @vaubaan/gateway-app (private)
packages/shared/         risk types, api-key, data-model            @vaubaan/shared
packages/policy-engine/  slice DSL, matcher, evaluator, runtime     @vaubaan/policy-engine
packages/gateway-core/   pipeline, decisions, refusals, audit       @vaubaan/gateway-core
plugins/<provider>/      one provider plugin per folder             @vaubaan/plugin-<provider>
docs/                    spec, decisions, handbook, tests, workflow, skills
scripts/                 dev-only scripts (empty after P0.1)
```

- `workspaces`: `apps/*`, `packages/*`, `plugins/*`. A new library goes
  under `packages/`, a new provider under `plugins/<provider-id>` named
  `@vaubaan/plugin-<provider-id>`, a new deployable under `apps/`.
- Every workspace has its own `tsconfig.json` extending
  `../../tsconfig.base.json` and a `type-check` script; `npm run
type-check` at the root fans out to all of them.
- Tests: Vitest collects `apps/*/tests/{unit,integration}`,
  `packages/*/tests/{unit,integration}`, `plugins/*/tests/unit` and
  co-located `*.test.ts` under `apps/*/src` and `packages/*/src`.
  Playwright runs `apps/gateway/tests/e2e`.
- Root files for contributors: `README.md`, `LICENSE` (Apache-2.0),
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`,
  `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`.
- Historical v4 documents are marked `status: legacy` or moved to
  `docs/**/legacy/` (ADR
  [legacy-status-of-v4-adrs-and-handbooks](../decisions/legacy-status-of-v4-adrs-and-handbooks.md)).
- Branches during the v5 build: `main` protected; `feat/<id>-<slug>`
  branches merge (no fast-forward) into the `v5` integration branch, which
  reaches `main` at milestones. CI runs on pushes and PRs to both.

## Environnements

| Env         | Hosting        | Supabase                                             | Provenance creds          |
| ----------- | -------------- | ---------------------------------------------------- | ------------------------- |
| **dev**     | localhost:3000 | local Supabase (à wire en Phase 5) ou prod pour stub | `.env.local`              |
| **staging** | Vercel preview | `staging.vaubaan.com`, Supabase staging              | Vercel env vars (preview) |
| **prod**    | vaubaan.com    | Supabase prod                                        | Vercel env vars (prod)    |

Pas de staging environment branche dédiée pour le MVP. Branches éphémères →
Vercel preview deploys.

## Branches

- `main` — la branche cardinale. Déployée automatiquement sur prod.
- `feature/*`, `fix/*`, `claude/*` — branches working. PRs vers main.

Les Bots Vaubaan (`github:developer`) suivent exactement ces patterns (cf.
ADR [[roles-naming-provider-scoped]]).

## PR process

1. Branche issue de main.
2. Implémentation suivant la discipline doc-first :
   - Spec/handbook _avant_ code si le changement touche un sous-système
     documenté (`tracks:` y pointe).
   - ADR si décision implicite émerge.
   - Test plan si nouveau scénario E2E ou intégration.
3. CI verte (cf. ci-dessous).
4. Self-review + commit conventionnel (`feat(scope):`, `fix(scope):`, etc.).
5. PR sur main → review → squash-merge.
6. Auto-deploy staging via Vercel preview ; merge → prod.

## CI (`.github/workflows/ci.yml`)

À chaque push main + chaque PR :

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - npm install --no-audit --no-fund
      - npm run type-check # tsc --noEmit par workspace
      - npm run lint # eslint . --max-warnings=0
      - npm run format:check # prettier --check .
      - npm run build # next build via workspaces
      - npm run test # vitest run
```

Pas de matrix Node, pas de cross-OS. Single Linux runner Node 22.

### Docker job (added by P0.4, 2026-10-13)

A second job, `docker`, runs after `check` on every push and PR to `main`
and `v5`: `docker/build-push-action` builds `deploy/docker/Dockerfile`
(`push: false`, `load: true`, GitHub Actions layer cache, build arg
`GIT_COMMIT_SHA=${{ github.sha }}`), then `deploy/docker/smoke.sh` runs the
container smoke test described in
[`docs/tests/e2e-tests.md`](../tests/e2e-tests.md) (fail-fast exit naming
the key, https rule, `/healthz`, redaction, native addons, non-root). The
image is not published; that is the release pipeline's job (P3.2).
Locally: `npm run docker:build && npm run docker:smoke`.

## Database migrations

The Supabase migrations workflow was removed with P0.1 (2026-10-13). v5
uses an embedded store whose forward-only migrations run at process boot;
the mechanism is specified by feature P0.3 of the v5 plan and will be
documented here when it lands.

## Local CI gate

> Updated 2026-10-12 (in English per the v5 repository rule).

`.husky/pre-commit` runs `lint-staged` on staged files only: ESLint
(`--max-warnings=0`) and Prettier check on `.ts/.tsx/.js`, Prettier check
on `.md/.json/.yaml/.css/.html`. It takes seconds. Type-check, tests and
the production build are **not** run locally anymore; they run in CI on
every push and pull request (`.github/workflows/ci.yml`). `npm run ci`
still exists to reproduce the full CI gate by hand.

Emergency bypass (do not abuse): `git commit --no-verify`.

## Dépendances

- `npm` workspaces (pas de pnpm/yarn). Node ≥ 20.
- `husky` + `lint-staged` pour le pre-commit hook.
- `tsx` pour les ops scripts.
- Tests : `vitest` (unit + integration), `@playwright/test` (E2E, planifié).

## Release

Pas de versioning sémantique du repo (private). Le déploiement = la release.
Vercel + Supabase prod = source de vérité.

## Doc-first discipline

Avant d'écrire du code qui :

- ajoute une décision cardinale → ADR (`/decision` skill ou manuel sous
  `docs/decisions/<slug>.md`).
- touche un sous-système avec un handbook → mettre à jour `docs/handbook/<x>.md`
  _avant_ le code (frontmatter `tracks:`).
- introduit un test scenario E2E → mettre à jour `docs/tests/e2e-tests.md`.
- change le workflow lui-même → mettre à jour ce fichier.

Le pre-commit hook ne vérifie pas la cohérence doc-code. Le drift est détecté
manuellement via le skill `/drift` (à wire en Phase 5+).
