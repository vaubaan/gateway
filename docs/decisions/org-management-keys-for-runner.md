---
title: Org Management Keys for programmatic AccessToken minting (Runner)
status: superseded
date: 2026-05-27
superseded-by: programmatic-access-token-minting
---

# Org Management Keys for programmatic AccessToken minting (Runner)

## Contexte

Le "Coding Agent Runner" — un service externe opéré côté customer (ou côté
Vaubaan pour les sessions managées) — doit être capable, **sans session
utilisateur**, de provisionner un `AccessToken` (`vbn_live_…`) pour démarrer
une session de coding sur un couple `(Project, Roles)`.

Aujourd'hui, `POST /api/v1/tokens` exige un cookie Supabase Auth
(`requireOrgMember`). Ça marche pour l'UI mais pas pour un service-to-service.

Trois constats encadrent la décision :

1. **L'`api_key` d'un AccessToken n'est visible qu'à la création** (argon2id
   at-rest, cf. [[api-key-format-vbn-live-argon2id]]). Donc "récupérer un
   AccessToken existant et son `api_key`" est architecturalement impossible.
   La sémantique attendue par le Runner ne peut être que "mint à chaque
   session".

2. **Un AccessToken n'est pas un creds d'administration.** Il porte des
   permissions MCP de consommation (allow/deny sur des tools provider) et
   est project-scoped. Lui rajouter le pouvoir de mint d'autres AccessTokens
   mélangerait deux concerns orthogonaux (consommer un service vs.
   l'administrer).

3. **Le hot-path gateway doit rester scope MCP only.** Tout endpoint
   programmatique d'administration vit côté REST (`/api/v1/*`), pas côté
   gateway (`/mcp`).

## Décision

**Nouvelle entité `OrgManagementKey`** — un Bearer credential org-scoped,
disjoint des AccessTokens, utilisé exclusivement pour authentifier des
appels REST programmatiques d'administration. **Quatre changements
coordonnés :**

### 1. Nouvelle table `org_management_keys`

Schéma parallèle à `access_tokens` mais scope = organization, sans project :

```
id, organization_id, name, api_key_prefix (UNIQUE), api_key_hash (argon2id),
status (active|revoked), last_used_at, created_by, created_at.
```

Pas de `expires_at` — la rotation est manuelle (le Runner garde sa key
en secret manager local, l'org admin la rotate quand besoin).

### 2. Nouveau préfixe `vbn_mgmt_…`

`packages/shared/src/api-key.ts` étendu avec le kind `mgmt` (prefix
`vbn_mgmt_<8-char>_<32-char secret>`). Le hash, la verify et le random-base62
sont identiques aux kinds `live`/`test`.

### 3. Nouvel endpoint `POST /api/v1/runner/tokens`

- Auth via `Authorization: Bearer vbn_mgmt_…` (`requireManagementKey`).
- Body : `{ projectSlug, roleIds, name?, ttlHours? }`.
- Default TTL **24h**, hard-cap **168h** (7j).
- Crée un AccessToken `status='active'`, `expires_at = now + ttlHours`.
- Retourne `{ access_token, api_key, expires_at }` — l'api_key visible **1×**.

### 4. Hot-path gateway respecte `expires_at`

- `access_tokens.expires_at` ajoutée (NULL = pas de TTL, comme aujourd'hui).
- `AccessTokenContext.access_token.expires_at` propagée.
- `McpGateway.authenticate()` rejette via `AuthError('access token has
expired.')` quand `now > expires_at`. Check fait sur cache hit ET cold path.
- `McpGateway.authenticate()` rejette aussi les clés `vbn_mgmt_…` envoyées
  par erreur sur `/mcp` (séparation claire des deux usages).

## Conséquences

**Positives**

- Séparation propre des creds (consommation MCP vs. administration).
  Compromis d'une management key ≠ compromis d'AccessToken et vice-versa.
- Un AccessToken Runner est ephémère (TTL ≤ 7j). Si le Runner fuite un
  token, la fenêtre d'exploitation est bornée. La rotation devient _gratuite_
  côté Runner — il en mint un nouveau à chaque session.
- L'org admin garde le contrôle via UI : il liste, voit `last_used_at`,
  révoque une key dès qu'il en a besoin.
- Aucun impact sur les flux UI existants — les AccessTokens créés via
  l'UI restent `expires_at=NULL` (long-lived) ; seul le Runner émet des
  tokens TTL'd.

**Négatives / à surveiller**

- Une management key compromise permet à l'attaquant de mint des
  AccessTokens dans n'importe quel project de l'org. Mitigation : RLS
  org-scoped + audit `last_used_at` + révocation rapide depuis UI.
  _À reconsidérer_ en v1.5 si on veut une granularité "management key
  scopée à 1 project".
- Les AccessTokens du Runner ne sont _pas_ explicitement marqués
  `runner-issued` en DB. Si on veut filtrer l'UI "AccessTokens créés
  par le Runner" il faudra ajouter une colonne `issued_by_management_key_id`.
  Décision : on attend que le besoin se manifeste — pour l'instant la
  convention de naming (`runner-<suffix>`) + l'absence de `created_by`
  suffisent à les identifier.

## Alternatives rejetées

### A. Étendre `access_tokens` avec un scope `mcp | management`

Une seule table, une colonne `scope` :

- `scope='mcp'` (default) → AccessToken classique.
- `scope='management'` → peut mint d'autres AccessTokens.

**Rejetée** : mélange deux concerns orthogonaux dans la même row (project
vs. org scope, RBAC humain vs. service-to-service, expiration courte vs.
indéfinie). Confusion garantie sur la UI ("pourquoi ce token n'a pas de
roles ?"). Et le gateway devrait quand même rejeter les `scope='management'`
sur `/mcp` — autant les loger dans une table à part dès le départ.

### B. Secret partagé global pour le Runner (env var)

`VAUBAAN_INTERNAL_SECRET` côté Runner, validé contre une env var côté
Vaubaan, et l'org-id passé dans le body.

**Rejetée** : un seul compromis = compromis de toutes les orgs. Pas de
révocation par-org. Pas de `last_used_at`. Pas multi-tenant safe. À
peine acceptable pour un MVP single-tenant, jamais pour Vaubaan Core
multi-tenant.

### C. Find-or-create idempotent sur `(project, roleIds)`

Le Runner envoie un tuple déterministe, on retourne l'existant si déjà
créé.

**Rejetée** car _impossible_ : l'`api_key` ne peut pas être retournée
(argon2id at-rest). Si on retourne seulement `id`/`prefix`, le Runner
n'a rien à mettre dans son header `Authorization` — il doit la stocker
côté lui. Et s'il la stocke, il n'a plus besoin de l'endpoint
"find-or-create" : il peut just garder son token et le réutiliser.
Mint-à-chaque-session avec TTL courte est plus simple et plus sûr.

### D. Auto-provisionnement d'une management key à la création de l'org

Mint à `POST /orgs`, envoi par email à l'owner.

**Rejetée** : surface de fuite par email pour des creds sensibles ;
floodage de mailboxes ; pas tout le monde a besoin d'un Runner. Mieux
vaut un opt-in explicit via la page Settings.
