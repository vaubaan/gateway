---
title: Coding Workflow
tracks:
  - .github/workflows/ci.yml
  - .github/workflows/supabase-migrations.yml
  - .github/workflows/e2e-nightly.yml
  - scripts/setup-e2e-secrets.md
  - vercel.json
  - package.json
  - packages/web/package.json
last_reviewed: 2026-05-22
---

# Coding Workflow

Modèle global du projet `cloud-resource-manager` :

- **Trunk-based, main-only.** Pas de branche `staging` ni `develop`
  en v1.
- **Auto-deploy Vercel sur `main`** : tout commit sur `main` (qu'il
  vienne d'un merge de PR ou d'un push direct) déclenche un deploy
  prod automatique.
- **Migrations Supabase auto-poussées sur `main`** quand un fichier
  sous `supabase/migrations/` est modifié.
- **PRs encouragées mais pas obligatoires** : il n'y a pas (encore)
  de branch protection sur `main`. La discipline est culturelle, pas
  technique (à revoir avant d'onboarder un second contributeur).

## 1. CI pipeline

3 workflows GitHub Actions, tous ciblés sur `main` :

| Workflow                                                                     | Trigger                                                                                                 | Jobs                                                                            | Durée typique |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------- |
| [`ci.yml`](../../.github/workflows/ci.yml)                                   | `push` sur `main`, `pull_request` vers `main`, `workflow_dispatch`                                      | `type-check`, `lint`, `format:check`, `build`, `test`                           | ~3-5 min      |
| [`supabase-migrations.yml`](../../.github/workflows/supabase-migrations.yml) | `push` sur `main` quand `supabase/migrations/**` ou `supabase/config.toml` change ; `workflow_dispatch` | `apply-prod` (psql session pooler vers prod, append-only ledger)                | ~1 min        |
| [`e2e-nightly.yml`](../../.github/workflows/e2e-nightly.yml)                 | `schedule` (03:00 UTC quotidien), `workflow_dispatch`                                                   | `sweeper` (clean `vauban-e2e-*` orphans > 24h) + `e2e` (Playwright real-clouds) | ~5-15 min     |

### Secrets CI requis

Workflow `supabase-migrations.yml` :

- `SUPABASE_DB_PASSWORD` — password Postgres du projet prod
  (`ynxfyklzqdumtixkdrco`).
- `SUPABASE_PROJECT_REF` — `ynxfyklzqdumtixkdrco`.
- `SUPABASE_POOLER_HOST` — pooler IPv4 (`aws-0-eu-west-3.pooler.supabase.com`
  ou équivalent — IPv6 du DB direct n'est pas atteignable depuis les
  runners GitHub).

Workflow `e2e-nightly.yml` (livré Phase 8) : 13 secrets `VAUBAN_E2E_*`
listés dans [`scripts/setup-e2e-secrets.md`](../../scripts/setup-e2e-secrets.md).
Setup en une fois via `gh secret set` (cf. snippet dans la doc opérateur).
Tant que ces secrets ne sont pas configurés, le workflow nightly
échoue avec un message clair (`Missing E2E env var: VAUBAN_E2E_…`).

### Points de rejet

CI rouge ⇒ pas de deploy. Vercel ne déclenche un build prod que si
les checks GitHub passent.

## 2. Env variants

| Env       | Où                                      | Distinguée par                         | Comment switcher                                                                                                               |
| --------- | --------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `local`   | machine dev                             | `packages/web/.env.local` (gitignored) | `npm run dev` (cible le projet prod Supabase actuel ; pas encore de Supabase local stack obligatoire).                         |
| `preview` | Vercel                                  | branche ≠ `main` poussée vers GitHub   | Push sur n'importe quelle branche déclenche un preview deploy automatique (URL `*.vercel.app`). Pas de Supabase preview en v1. |
| `prod`    | Vercel project `cloud-resource-manager` | branche = `main`                       | Auto-deploy à chaque merge dans `main`. Pas de staging séparé.                                                                 |

Pas de `staging` en v1. Sera ajouté une fois qu'une seconde org sera
onboardée et qu'un risque de régression justifiera le coût opérationnel.

### Variables d'environnement

Liste dans :

- `.env.example` (racine) — vars opérateur (`SUPABASE_MGMT_TOKEN`,
  `VERCEL_TOKEN`, `GITHUB_ORG_ADMIN_TOKEN`, etc.).
- `packages/web/.env.local.example` — vars runtime web
  (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`).

Les vars Vercel prod sont gérées via API (`VERCEL_TOKEN` +
`VERCEL_TEAM_ID`) — à committer un script `scripts/sync-vercel-env.sh`
quand l'onboarding grandira.

## 3. PR process

**Pas de PR obligatoire en v1.** L'auteur solo (`rpelissier`) push
directement sur `main` après avoir validé localement (`npm run
type-check && npm run lint && npm run test && npm run build`).

Conventions à respecter même en push direct :

- **Commits conventionnels** : `feat(...)`, `fix(...)`, `chore(...)`,
  `docs(...)`, etc. Cf. `git log` pour le style observé.
- **Doc-first** : tout commit de feature inclut sa doc (handbook /
  test-plan / ADR si non-trivial), cf. `AGENTS.md` §3.
- **DoD locale avant push** : type-check, lint, format:check, build,
  test passent.

Quand un second contributeur arrive :

- Activer branch protection sur `main` (require status checks +
  require PR).
- Ajouter `.github/PULL_REQUEST_TEMPLATE.md`.
- Documenter CODEOWNERS.

## 4. Branch model

- **Trunk-based** : `main` est l'unique long-lived branch.
- **Pas de branche `staging` ni `develop`** en v1.
- **Feature branches** créées localement (`feature/<slug>`),
  mergées dans `main` avec `--no-ff` pour préserver la trace dans
  l'historique. Lifetime cible : quelques heures à 2 jours max.
- **Pas de tags `v<X>.<Y>.<Z>`** en v1 (versionnement git non
  publié). À introduire quand on aura un changelog public.

L'orchestrateur de build (`/big-build`, cf.
[`.claude/build-plans/init.json`](../../.claude/build-plans/init.json))
crée une branche `feature/<feature-id>` par sub-feature et merge
chacune dans `main` après vérification de la DoD. C'est le pattern
courant en v1.

## 5. Mise en prod / release

- **Trigger** : auto sur `main`. Aucun bouton "Deploy" à actionner —
  Vercel build se déclenche dès que GitHub Actions CI passe.
- **Commande équivalente local** : aucune (le deploy n'est pas
  scripté côté repo ; Vercel pilote tout via son intégration GitHub).
- **Tag** : pas de tagging git en v1.
- **Auto-deploy** : oui, sur `main` uniquement. Les preview deploys
  des autres branches restent éphémères.
- **Rollback** : depuis le dashboard Vercel
  (`https://vercel.com/<team>/cloud-resource-manager/deployments`) →
  pick a previous deployment → "Promote to Production". TTR cible
  < 5 min. Alternative CLI : `vercel rollback <deployment-id>`.
- **Migrations Supabase = irréversibles** : si une migration
  problématique est mergée, le rollback nécessite une _nouvelle_
  migration corrective (jamais éditer une migration déjà appliquée
  sur prod). La ledger `supabase_migrations.schema_migrations`
  enregistre les versions appliquées.
- **Fenêtres de freeze** : aucune fenêtre formelle en v1. Bonne
  pratique : éviter les merges le vendredi après-midi tant qu'il
  n'y a pas de monitoring/oncall.
- **Communication** : aucun canal formel en v1 (équipe solo). Le
  changelog implicite est `git log`.

## Références

- ADR [stack-nextjs-supabase-vercel.md](../decisions/stack-nextjs-supabase-vercel.md)
  — choix de stack qui détermine ce workflow.
- ADR [greenfield-rip-and-replace.md](../decisions/greenfield-rip-and-replace.md)
  — pourquoi pas de staging en v1.
- Spec : [`../spec/cloud-resource-manager.md`](../spec/cloud-resource-manager.md)
  §13 (plan de cutover).
- Test plans :
  [`../tests/integration-tests.md`](../tests/integration-tests.md),
  [`../tests/e2e-tests.md`](../tests/e2e-tests.md).
- Build plan init :
  [`../../.claude/build-plans/init.json`](../../.claude/build-plans/init.json).
