---
title: Coding workflow
status: current
date: 2026-05-22
last_synced: 2026-10-12
tracks:
  - .github/workflows/
  - vercel.json
  - package.json
  - .husky/pre-commit
---

# Coding workflow

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

## Migrations Supabase (`.github/workflows/supabase-migrations.yml`)

Trigger : push main affectant `supabase/migrations/**`.

Appliquer via `psql` via Session Pooler (IPv4) en utilisant les secrets
`SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`, `SUPABASE_POOLER_HOST`.

Ledger `supabase_migrations.schema_migrations` empêche la ré-application.

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
