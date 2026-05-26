---
title: Env vars — où vit quoi, et pourquoi
status: current
date: 2026-05-26
tracks:
  - .env
  - .env.test
  - packages/web/.env.local.example
---

# Env vars — où vit quoi, et pourquoi

Le projet maintient **trois fichiers d'env** distincts. Ils ne sont **pas
interchangeables**. Confondre les deux planes (Vaubaan Core vs fake customer)
a causé 3 incidents en mai 2026.

## Les 3 fichiers

| Fichier                   | Audience                                                  | Plane                                  | Niveau de scope token                            |
| ------------------------- | --------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `/.env`                   | Opérateur (toi) : scripts seed, MCP servers, CLI `vauban` | **Vaubaan Core** (notre SaaS)          | Master / user-wide (Mgmt PAT, perso PAT)         |
| `/.env.test`              | Opérateur, mais en rôle de faux customer                  | **Fake customer** (`sbw-vaubaan-test`) | Master tokens scopés au faux customer uniquement |
| `packages/web/.env.local` | Next.js webapp en local dev                               | Vaubaan Core (runtime)                 | Service-role / App-scoped uniquement             |

> Mirror : `packages/web/.env.local` = exactement ce qui doit être sur Vercel
> en production. Synchroniser via `vercel env ls/add` quand un var change.

## Pourquoi cette séparation

### 1. Blast radius

Si une var du webapp fuit (bug, log, bundle accidentel), tu veux que ce soit
une key **scopée à un projet précis**, pas un Mgmt PAT user-wide qui ouvre
tout ton compte Supabase / GitHub.

| Token type                     | Fichier                   | Blast radius si leak                      |
| ------------------------------ | ------------------------- | ----------------------------------------- |
| `SUPABASE_MGMT_TOKEN`          | `/.env`                   | Tous tes projets Supabase, à vie          |
| `SUPABASE_SERVICE_ROLE_KEY`    | `packages/web/.env.local` | Un seul projet, RLS-bypassed mais rotable |
| `GITHUB_ORG_ADMIN_TOKEN` (PAT) | `/.env`                   | Toutes les orgs où tu es admin            |
| `GITHUB_APP_PRIVATE_KEY`       | `packages/web/.env.local` | Les installations explicites de l'App     |

### 2. Two-tenant clarity

`/.env` (Core) et `/.env.test` (fake customer) **ne doivent jamais être
confondus**. Le suffix `-test` partout (GitHub org `sbw-vaubaan-test`, team
Vercel `sbw-vaubaan-test`, etc.) est ton garde-fou visuel. Un fichier séparé
par plane multiplie la lisibilité par 10 vs un seul fichier inliné.

> Cf. `architecture-two-tenants` (memory). Si jamais tu vois un token "Core"
> sans suffix utilisé dans un script de test (ou inversement), c'est un bug.

### 3. Vercel mirror 1-to-1

Pour pousser un var en prod : `cd packages/web && vercel env add NAME production`.
Le contenu doit matcher `packages/web/.env.local`. Pas de "ah celle-ci je l'ai
mise sur Vercel mais pas en local". Si en doute → `vercel env pull` puis diff.

## Cheat sheet "où je mets quoi"

| Variable                             | Fichier                   |
| ------------------------------------ | ------------------------- |
| `SUPABASE_MGMT_TOKEN`                | `/.env`                   |
| `SUPABASE_CORE_PROJECT_REF`          | `/.env`                   |
| `VAUBAAN_CORE_DB_PASSWORD`           | `/.env`                   |
| `GITHUB_ORG_ADMIN_TOKEN` (Core)      | `/.env`                   |
| `VERCEL_TOKEN`                       | `/.env`                   |
| `GITHUB_ORG_ADMIN_TOKEN` (test)      | `/.env.test`              |
| `VERCEL_TEAM_TOKEN` (test)           | `/.env.test`              |
| `SUPABASE_TOKEN` (test customer)     | `/.env.test`              |
| `NEXT_PUBLIC_SUPABASE_URL`           | `packages/web/.env.local` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`      | `packages/web/.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY`          | `packages/web/.env.local` |
| `GITHUB_APP_ID`/`SLUG`/`PRIVATE_KEY` | `packages/web/.env.local` |
| `VERCEL_INTEGRATION_SLUG`            | `packages/web/.env.local` |
| `VERCEL_OAUTH_CLIENT_ID`/`SECRET`    | `packages/web/.env.local` |
| `SUPABASE_OAUTH_CLIENT_ID`/`SECRET`  | `packages/web/.env.local` |
| `UPSTASH_REDIS_*`                    | `packages/web/.env.local` |

## Tests E2E

`.env.test` est chargé par les scripts `seed-customer.sh` et les Playwright
specs qui simulent le flow d'un customer qui s'inscrit. Voir
`docs/tests/e2e-tests.md` pour le détail des scénarios.
