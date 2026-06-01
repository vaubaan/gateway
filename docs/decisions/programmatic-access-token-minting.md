---
title: Programmatic AccessToken minting — neutral namespace, DELETE, expired purge
status: accepted
date: 2026-06-01
supersedes: org-management-keys-for-runner
tracks:
  - docs/spec/vaubaan-gateway.md
  - supabase/migrations/0003_org_management_keys.sql
  - supabase/migrations/0010_purge_expired_access_tokens.sql
  - packages/web/src/app/api/v1/mgmt/tokens/route.ts
  - packages/web/src/app/api/v1/mgmt/tokens/[tokenId]/route.ts
  - packages/web/src/app/api/v1/mgmt/roles/route.ts
  - packages/web/src/app/api/v1/mgmt/projects/route.ts
  - packages/web/src/lib/auth/require-management-key.ts
---

# Programmatic AccessToken minting — neutral namespace, DELETE, expired purge

## Contexte

L'ADR [[org-management-keys-for-runner]] a introduit la `OrgManagementKey`
(`vbn_mgmt_…`) et le endpoint `POST /api/v1/runner/tokens` pour permettre
à un service externe de minter des AccessTokens éphémères sans session
utilisateur. Trois trous sont apparus à l'usage :

1. **Le vocabulaire « Runner » présume du porteur.** Une ManagementKey peut
   être utilisée par un agent de coding, mais aussi par un script CI, un
   curl manuel, un cron interne, ou n'importe quel automaton. Le même
   principe que pour le rename Bot → AccessToken (cf.
   [[flat-membership-org-owner-access-token]]) s'applique : _le naming
   présume de l'usager là où on n'a pas à le faire_. Le namespace URL
   `/api/v1/runner/*` et les mentions « CAR / Coding Agent Runner » dans
   spec / ADR / code reflètent un seul usecase, pas la sémantique de la
   ressource.

2. **Pas de DELETE accessible via ManagementKey.** `DELETE /api/v1/tokens/:id`
   exige `requireOrgMember` (session cookie). Un consommateur programmatique
   ne peut donc pas révoquer un AccessToken juste après usage — il doit
   attendre l'expiration. Conséquence observée : accumulation de tokens
   en DB.

3. **Aucune purge des tokens expirés.** Le hot-path rejette via
   `AuthError('access token has expired.')` quand `now > expires_at`, mais
   les rows restent en table indéfiniment. La table grossit pour rien.

## Décision

Trois changements coordonnés :

### 1. Drop « Runner / CAR » partout. Namespace neutre `/api/v1/mgmt/*`

- `POST /api/v1/runner/tokens` → `POST /api/v1/mgmt/tokens`
- `GET  /api/v1/runner/roles` → `GET  /api/v1/mgmt/roles`
- `GET  /api/v1/runner/projects` → `GET  /api/v1/mgmt/projects`

Le préfixe `/mgmt/` qualifie le **mode d'authentification** (Bearer
ManagementKey) — pas le porteur. La spec, les commentaires, les ADRs et
la doc UI sont purgés des termes « Runner / CAR / Coding Agent Runner ».

Aucun changement de schéma DB (table `org_management_keys` déjà neutre,
préfixe `vbn_mgmt_…` déjà neutre). Aucun changement de contract pour
les consommateurs côté credentials — seules les URLs bougent.

### 2. `DELETE /api/v1/mgmt/tokens/:tokenId`

Nouvelle route, auth via `requireManagementKey` :

- Bearer `vbn_mgmt_…` org-scoped.
- Vérifie que le token visé appartient à un project de l'org bound à
  la ManagementKey (404 sinon).
- Supprime la row dans `access_tokens` + invalide le cache
  `vaubaan:ctx:<prefix>`.

L'endpoint existant `DELETE /api/v1/tokens/:tokenId` reste en place pour
le flux UI (session cookie). Deux routes, deux modes d'auth, surface
de risque cloisonnée.

### 3. Purge quotidienne des AccessTokens expirés (pg_cron, grace 7j)

Migration `0010_purge_expired_access_tokens.sql` :

- `create extension if not exists pg_cron;`
- Job quotidien : `delete from access_tokens
where expires_at is not null and expires_at < now() - interval '7 days'`.

Grace period de **7 jours** : laisse une fenêtre d'audit (un humain qui
relit les logs peut encore corréler un `api_key_prefix` ↔ token, même
expiré). Au-delà, la row n'a aucune utilité (le hot-path rejette via
`expires_at` bien avant). Les AccessTokens long-lived (`expires_at IS
NULL`, créés via UI) ne sont jamais touchés par le job.

## Conséquences

**Positives**

- Vocabulaire de la spec et du code aligné avec la nature réelle des
  ressources (neutre / sans présumer du porteur).
- Les consommateurs programmatiques peuvent maintenant clean-up explicitement
  (`DELETE /api/v1/mgmt/tokens/:id`) après usage — pas besoin d'attendre
  l'expiration ; et la DB ne s'accumule pas avec des tokens expirés.
- Deux namespaces `/api/v1/*` (session) vs `/api/v1/mgmt/*` (Bearer)
  rendent visible au premier coup d'œil le mode d'auth d'un endpoint.
- pg_cron vit avec la donnée — pas de surface API à sécuriser pour
  un job de housekeeping.

**Négatives / à surveiller**

- Le rename `/runner` → `/mgmt` est _breaking_ pour tout consommateur
  programmatique existant. Mitigation : la cible est interne aujourd'hui
  (sessions de coding pilotées Vaubaan-side) ; les rares consommateurs
  externes seront notifiés à la release.
- Le DELETE via ManagementKey élargit légèrement la surface de risque
  d'une ManagementKey leakée (avant : pouvait mint des tokens éphémères ;
  maintenant : peut aussi supprimer des tokens existants de n'importe
  quel project de l'org). Acceptable car le compromis principal restait
  déjà critique, et la révocation rapide depuis UI reste l'arme principale.
- pg_cron est une extension Supabase-managed ; si on migre un jour vers
  un Postgres self-hosted sans pg_cron, il faudra basculer sur un cron
  externe appelant un endpoint dédié.

## Alternatives rejetées

### A. Étendre `DELETE /api/v1/tokens/:tokenId` pour accepter aussi `Bearer vbn_mgmt_…`

Un seul endpoint, auth multi-mode (cookie OR Bearer).

**Rejetée** : casse la symétrie `/api/v1/*` = session vs `/api/v1/mgmt/*` =
Bearer qu'on cherche justement à établir. Un endpoint avec deux modes
d'auth oblige à brancher chaque check dans la route — duplication
silencieuse de la logique de garde. Préférable : un endpoint par mode
d'auth, une garde par endpoint.

### B. Garder « Runner » comme namespace, juste ajouter `DELETE` + purge

Plus petit diff.

**Rejetée** : le mot « Runner » reste comme contamination dans le code
et la spec. Mieux vaut faire le rename une fois, propre, dans une PR qui
porte aussi le DELETE et la purge — toutes ces choses touchent la même
zone et se motivent mutuellement.

### C. Pas de purge en DB, juste rejet hot-path (status quo)

Compter sur les consommateurs pour `DELETE` après usage.

**Rejetée** : on ne peut pas présumer que tous les consommateurs cleanup
proprement. Un consommateur naïf accumule, la table grossit pour rien,
et l'oubli côté client n'a aucun signal côté Vaubaan. Une purge serveur-side
est un filet de sécurité naturel — coût quasi-nul, gain certain.

### D. Grace period nulle (purge dès expiration)

Plus simple.

**Rejetée** : un humain qui audite _a posteriori_ perd toute trace du
prefix associé à un appel récent qui a échoué pour `expired`. 7 jours
est un compromis entre nettoyage et capacité de forensic court-terme.

### E. Renommer aussi `ManagementKey` en `OrgToken` / `AccessToken` en `ProjectToken`

Symétrie de naming par scope.

**Rejetée** : `ManagementKey` et `AccessToken` sont déjà neutres et
différenciés sur la _fonction_ (administrer vs accéder au MCP) — plus
informatif que la distinction par scope. Et `access_tokens` est le nom
canonique de la table depuis 0001 ; un rename massif pour un gain
sémantique faible n'a pas le ratio risque/bénéfice.
