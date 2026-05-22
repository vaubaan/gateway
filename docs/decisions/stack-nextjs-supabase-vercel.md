---
title: Next.js 15 + Supabase + Vercel as the CRM stack
status: accepted
date: 2026-05-21
author: rpelissier
tracks: []
---

# Next.js 15 + Supabase + Vercel as the CRM stack

## Contexte

Le Cloud Resource Manager (cf. `docs/spec/cloud-resource-manager.md`) est un sous-système multi-tenant qui doit :

- Servir une UI riche (listing de Resources, wizards de registration, pages d'export `.env` / `mcp.json`).
- Tenir une API REST (`/api/crm/v1/*`) co-localisée avec l'UI pour partager les sessions et la couche d'auth.
- Persister un schéma SQL avec RLS multi-tenant strict (spec §3, §3.3).
- Authentifier les users (email/password) avec un flow qui s'intègre à la dérivation de la KEK Argon2id côté browser (spec §4.1).
- Se déployer sans ops dédiée — pas d'équipe SRE.

On part _greenfield_ (spec §13). Aucune contrainte de migration d'un existant ; on peut choisir librement le socle. Cette ADR fige le choix.

## Décision

On adopte le triplet **Next.js 15 (App Router), Supabase (Postgres 17, Auth, RLS) et Vercel**, déployé depuis le monorepo `cloud-resource-manager` avec `rootDirectory=packages/web`.

- **Next.js 15** : App Router (Server Components + Route Handlers) avec TypeScript strict (`noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`). Vise React 19.
- **Supabase** : Postgres 17, Auth email/password, RLS active sur toutes les tables métier. Projet prod `ynxfyklzqdumtixkdrco` ; pas d'env staging en v1 (cf. `docs/spec/cloud-resource-manager.md §13`).
- **Vercel** : production deploy automatique sur `main` ; pas d'env preview obligatoire en v1. Project `cloud-resource-manager` (`prj_YIZU1wylh5rX1FPGzEa0KN3ugqwf`).
- **CI** : GitHub Actions pour `type-check / lint / format / build / test`, plus le workflow `supabase-migrations.yml` qui pousse les migrations vers prod via psql session pooler (port 5432, IPv4, contournement de l'IPv6-only du DB direct).

Les helpers `@supabase/ssr` sont la seule couche d'accès Supabase côté code applicatif (cf. `packages/web/src/lib/supabase/`). Le service-role key n'est jamais importé dans un fichier client ; il est réservé aux route handlers et server actions qui en ont strictement besoin.

## Conséquences

### Positives

- **Zero-ops baseline** : Vercel et Supabase gèrent l'infra, l'auth, le SSL, les sauvegardes Postgres. Pas de VPS à entretenir pour le Core (le seul VPS du périmètre Vauban est l'Org Runner, hors CRM).
- **Cohérence du langage** : tout est TypeScript (front + API + migrations applicables depuis `@supabase/supabase-js`). Pas de context-switching Go/Rust/Python.
- **RLS-first** : la sécurité d'isolation org est tenue par Postgres, pas par du code applicatif → la spec §3.3 est directement exprimable en SQL. Le bug "j'ai oublié le `where org_id=…`" est impossible.
- **Edge runtime disponible** pour le middleware d'auth Supabase (rafraîchissement de session sans round-trip serveur).

### Négatives / contraintes

- **Lock-in modéré sur Supabase** : la couche Auth et le format des policies RLS sont spécifiques. Migrer vers un Postgres self-host reste possible (RLS est standard) mais réécrit l'auth.
- **Vercel build constraints** : `rootDirectory=packages/web` signifie que le `buildCommand` doit remonter à la racine du monorepo pour installer les workspaces (cf. `vercel.json`). Si on grossit, il faudra envisager Vercel Monorepo natif ou un Nx/Turbo.
- **App Router maturity** : Next.js 15 + React 19 est récent ; on accepte des breaking changes mineurs entre minor releases. La spec §10 (no cleartext logs) impose de revoir tout middleware tiers qu'on ajouterait.
- **Pas de preview env automatique branchée à un Supabase preview** : v1 fonctionne main-only ; la séparation prod/preview viendra avec un Supabase branching plus tard.

## Alternatives rejetées

### Stack maison Node + Express + Prisma + Postgres self-host

Donne plus de contrôle, mais on perd l'auth clé-en-main et la RLS managée. La spec §1 dit explicitement "Vauban Core vit dans le cloud public" — c'est une posture délibérée pour réduire l'ops.

### Remix + PlanetScale + Fly.io

Stack séduisante côté DX, mais PlanetScale (MySQL) ne supporte pas le RLS Postgres-style ; il faudrait porter toute la spec §3.3 en code applicatif. Échange un risque managé (lock-in Supabase) contre un risque structurel (sécurité d'isolation pas garantie au niveau DB).

### Bun + Hono + Drizzle + Supabase

Toujours Supabase derrière, mais on remplace Next.js par un framework plus léger. Inconvénient : on perd les RSC (qui aident à ne pas envoyer le bundle JS du SealedInput vers les pages où il n'est pas utile). Et on doit recréer la couche file-system routing. Le gain de perf n'est pas prioritaire en v1 (volume CRM faible).

### SaaS no-code (Retool, Appsmith)

Disqualifié par §4 : la cryptographie zero-knowledge doit vivre dans un browser qu'on contrôle. Un dashboard low-code ne peut pas tenir la promesse ZK (composants `<SealedInput>`, gestion locale de la sk).

## Références

- `docs/spec/cloud-resource-manager.md` §1, §3, §10, §13.
- `.claude/build-plans/init.json` phase 0 (bootstrap-monorepo).
- `docs/decisions/rls-minimaliste-2-roles.md` (RLS design).
- `docs/decisions/crypto-libsodium-sealed-box-multi-recipient.md`.
