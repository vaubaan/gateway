# MCP Proxy — spec

> **Statut :** spec greenfield.
>
> **⚠️ Note 2026-06-15 — Capabilities → Risk-based (3ème évolution) :**
> Le modèle **capabilities** introduit en 2026-06-08 (tuple `(provider,
> plane, level, action, env?)`) est **remplacé** par le **modèle
> risk-based**. Le token ne porte plus une liste de capabilities ; il
> porte une liste de **risques acceptés** (`accepted_risks: RiskId[]`)
> qualifiée par binding. Chaque provider déclare désormais : (a) un
> **data-model** (graphe d'entités + cardinalités), (b) un **catalogue
> de risques** versionné (YAML), (c) un classifieur qui émet la
> **slice** touchée au call. La policy projet devient une table légère
> d'override (`project_risk_policies : risk_id → gate`). Le gate
> vocabulaire (`allow|confirm|deny`) et l'approval flow (Telegram +
> Manual + nouveau Email) sont conservés. Source de vérité du nouveau
> modèle : [[gateway-risk-model]] (DRAFT v4). Audit de cohérence
> et plan de migration : `/.vaubaan/reports/v4-coherence-audit.md` +
> `/.vaubaan/reports/v4-migration-plan.md`. ADR
> `pivot-to-risk-based-model` à drafter au réveil.
>
> **⚠️ Note 2026-06-08 — Roles → Capabilities :** le modèle **roles +
> policy-DSL déclaratif** (§0, §2.2, tables `roles`/`access_token_roles` en §3,
> §5 roles builtin, §6 DSL) est **remplacé** par le **modèle de capabilities**.
> Une capability est un tuple `(provider, plane, level, action, env?)` porté
> directement par l'AccessToken (`access_tokens.capabilities` jsonb) ; la
> classification `(tool, args) → capability` vit dans chaque plugin provider
> (`classify()`), plus dans un DSL en base. Les actions se réduisent à
> `read`/`write` ; `env` est un calque par-data (la branche **est** l'env pour
> github). Au mint, le `policy_rules` du projet décide ai-autonome vs
> human-gated (migration `0012`) ; les requêtes human-gated passent par un
> `ApprovalChannel` (manual ou Telegram, migration `0013`) et sont consommées
> via le poll endpoint. Les tokens `singleUse` (migration `0014`) sont
> consommés au premier call qui matche, donnant le grain par-acte. Source de
> vérité du nouveau modèle : [[gateway-capability-model]] + migrations
> `0011`–`0014`. ADR `capabilities-replace-roles` à venir. Les sections
> ci-dessous décrivant roles/DSL sont historiques jusqu'à réécriture.
>
> **⚠️ Note 2026-05-26 :** depuis l'ADR
> [[flat-membership-org-owner-access-token]] le terme **Bot** est renommé en
> **AccessToken** (table `access_tokens`, URL `/tokens`) et le RBAC humain
> 2-tier (`member`/`admin`) est remplacé par un modèle plat avec **owner
> unique par org**. Les sections §0, §2.1, §2.2, §3.1-3.3, §4.1, §4.3
> sont à jour. Les sections narratives §5+ peuvent encore mentionner "Bot"
> dans leur texte — sémantiquement équivalent à "access token".
>
> Ce document remplace toute version antérieure
> de la gestion de cloud resources / credentials / MCP côté Vaubaan Core.
> Le code et la doc précédents (`cloud-resource-manager.md`, packages
> `core`/`crm-catalog`/`web`, migrations Supabase, ADRs ZK + Infisical) ont
> été retirés intégralement dans ce repo le 2026-05-22. Pas de dual-write,
> pas de migration de données, on repart d'une feuille blanche.
>
> **Filiation v3.** Cette spec remplace une codebase précédente
> (**Vaubaan Cloud Resource Manager v3**) archivée dans l'historique git de
> ce même repo (tag `v3-final` à poser). Refonte from-scratch — pas de
> code partagé, pas de migration, pas de compat. Un agent d'implémentation
> peut **consulter ponctuellement** v3 via git pour référence (anciens
> schémas DB, patterns UI, traces de décisions implicites) mais ne doit
> **pas l'absorber en bloc** dans son contexte : cette spec est faite
> pour être auto-portante.

## 0. Vocabulaire

Le MCP Gateway raisonne sur ces termes (modèle risk-based — cf.
[[gateway-risk-model]] pour la spec détaillée) :

- **CloudProvider** — le SaaS lui-même (GitHub, Vercel, Supabase, Railway,
  SSH). Statique dans le catalogue. Pas une row DB, juste une string
  référencée par les ProviderAdmins et ProviderBindings.
- **Organization** — tenant racine côté Vaubaan. Isolation RLS stricte.
- **Project** — sous-unité d'une Organization. Porte ses ProviderBindings,
  ses AccessTokens, sa risk-policy.
- **ProviderAdmin** — bundle de credentials que Vaubaan Core détient au niveau
  organisation pour un Provider, **issu d'un flow OAuth/App install** (jamais
  paste-token). Stocké chiffré at-rest, déchiffré en mémoire à chaque
  call upstream.
- **ProviderBinding** — lien concret entre un Project et une ressource côté
  Provider (`acme/app` pour GitHub, `prj_xxx` pour Vercel, project_ref pour
  Supabase, UUID projet pour Railway). Le segment du data-model qui qualifie
  les slices émises par le classifieur du plugin.
- **AccessToken** — identité émise par Vaubaan, **project-scoped**, porteur
  d'un `accepted_risks: RiskId[]` (et d'un éventuel `denied_risks` opt-out).
  Identifié par une `api_key` Vaubaan (`vbn_live_xxxx…`). Consommé
  indistinctement par un agent LLM, un script CI, un cron ou un humain.
  Peut porter un `expires_at` (TTL — default 24h, max 7j) et un flag
  `singleUse`.
- **ManagementKey** — Bearer credential **org-scoped**, distinct des
  AccessTokens et **inutilisable** sur le MCP gateway. Préfixe `vbn_mgmt_…`.
  Authentifie tout client programmatique (CI job, script de bootstrap,
  automation) sur `POST /api/v1/mgmt/tokens` pour qu'il puisse mint des
  AccessTokens. Cf. ADR [[programmatic-access-token-minting]].
- **RiskId** — identifiant d'une entrée du catalogue de risques d'un
  provider (`supabase[staging].bulk-row-write`, `github.mint-install-token`).
  Forme `<provider>[<env>].<name>` ou `<provider>.<name>`. C'est ce que le
  token accepte (`accepted_risks`).
- **Slice** — selecteur interne `provider.entity[selector].action` émis par
  le classifieur au call (`github.repo[acme/app].branch[main].W`). Jamais
  dans le wire utilisateur — purement plomberie entre plugin et runtime.
- **RiskCatalog** — fichier YAML par provider (`packages/providers/<vendor>/
  src/risk-catalog.yaml`) listant les `RiskEntry` avec leur `matches` (slice
  pattern), `vector` (6D), `default_gate` (`allow|confirm|deny`).
- **ProjectRiskPolicy** — table `project_risk_policies` qui override le
  `default_gate` du catalogue pour un projet donné (par `risk_id` ±
  `env_scope`). Trois gates : `allow`, `confirm` (déclenche approval),
  `deny`.
- **MCPGateway** — endpoint `/mcp` de Vaubaan Core. JSON-RPC. Auth par
  `Authorization: Bearer <api_key>`.
- **AuditLog** — une row par call MCP, allow ou deny : (access_token, tool,
  args_hash, slices_executed, risks_touched, token_accepted_risks_snapshot,
  decision, upstream_latency).

**Distinction clé :** Vaubaan ne *distribue* plus de credentials cloud. Vaubaan
*intermédie* des calls MCP. L'agent ne reçoit jamais de token provider ;
il ne reçoit que la réponse à un call autorisé.

## 1. Vision

Le **MCP Proxy** est le sous-système de Vaubaan Core qui :

1. **Connecte** les CloudProviders d'une Organization via OAuth/App install
   (le seul moment où Vaubaan acquiert des creds — Vaubaan Core stocke un
   token long-lived ou un installation_id, mais l'écran de consent est
   géré par le provider).
2. **Catalogue** les Roles disponibles par Provider (builtin v1, custom v2).
3. **Émet des Bots** — identités agent project-scoped, porteuses d'une
   `api_key` Vaubaan et de N Roles.
4. **Filtre** chaque MCP call d'un agent : `auth(api_key) → load(roles,
   bindings, provider_admin) → policy(tool, args) → mint(ephemeral_upstream_token)
   → forward(upstream_mcp_server)`.
5. **Audit** chaque call (allow ou deny) avec qui/quoi/décision/latence.

Le MCP Proxy vit dans le cloud public (Vaubaan Core, Next.js + Supabase +
Vercel) et est multi-tenant.

**Positionnement** : *"policy-enforcing MCP gateway pour Coding Agents"*.
Pas de concurrent direct (Composio / Arcade.dev s'en approchent, Cloudflare
AI Gateway le fait pour LLM APIs).

**Pas un secret manager.** Si une équipe a besoin d'un SM séparé pour ses
devs humains, elle utilise Infisical / Vault / 1Password à côté. Vaubaan
détient *uniquement* les creds provider que l'org admin lui confie via
OAuth, et *uniquement* pour le router des calls MCP.

### 1.1 Hors-scope explicite

- **Aucun proxy CLI ou SDK** en v1. Seul MCP est intercepté. Les agents qui
  font des appels HTTPS directs (Octokit, Vercel SDK, etc.) bypass le proxy.
  CLI/SDK = v2 via MITM TLS proxy avec custom CA.
- **Aucune réintroduction du ZK**. Impossible de filtrer un call
  sémantiquement sans déchiffrer le token et faire l'appel soi-même.
  C'est définitif.
- **Aucun secret management généraliste**. Pas de `/exports/env`, pas de
  `mcp.json` export, pas de stockage de secrets autres que ceux strictement
  nécessaires au gateway (les ProviderAdmin tokens).
- **Aucun provisioning de ressources cloud**. Vaubaan ne crée pas de repos,
  pas de Vercel projects, pas de Supabase projects. L'org admin va chez le
  Provider et registre la ressource via un ProviderBinding.
- **Aucun check stateful** en MVP. Les Policies sont stateless : décision
  à partir du `(tool_name, arguments)` du call. Les checks qui demandent
  un fetch upstream préalable (ex: "CI verte avant merge") sont Phase 5+.
- **Aucune notion de `Job`, `JobKind`, `JobExecutor`**. Le gateway expose
  des fonctions synchrones de Core, appelées par un Bot authentifié.

## 2. Domaine

### 2.1 Hiérarchie

```
CloudProvider           (statique : 'github' | 'vercel' | 'supabase')
   │
   │  est connecté par
   ▼
Organization (owner_id : FK auth.users, unique, transferable)
   ├── ProviderAdmins[]      1 par CloudProvider connecté (post-OAuth/App install)
   ├── RoleCatalog[]         provider-scoped, builtin global + custom (v2) org-level
   ├── OrgMembers[]          membership plat — tout member a full RW
   ├── ManagementKeys[]      org-scoped Bearer creds /api/v1/mgmt/* (vbn_mgmt_…)
   └── Projects[]
         ├── ProviderBindings[]    1 par CloudProvider activé pour ce Project
         └── AccessTokens[]        project-scoped, porteurs de N Roles
                                   (optionnellement expires_at — mgmt-minted)

AuditLog (transversal)     one row per MCP call : (access_token, tool, args_hash,
                                                    role_matched, decision,
                                                    upstream_latency_ms)
```

### 2.2 Définitions

| Entité              | Définition courte                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **User**            | Compte humain Vaubaan. Auth Supabase (magic-link + Google OAuth). Peut appartenir à plusieurs Organizations.                                |
| **Organization**    | Tenant racine. Isolation RLS stricte.                                                                                                      |
| **Project**         | Sous-unité d'une Org. Porte ses ProviderBindings et ses AccessTokens.                                                                      |
| **CloudProvider**   | SaaS supporté. Statique. Identifié par string (`github`, `vercel`, `supabase`).                                                            |
| **ProviderAdmin**   | Bundle de credentials que Vaubaan détient au niveau Org pour un Provider, issu d'un flow OAuth/App install. 1 par (org, provider).          |
| **ProviderBinding** | Référence concrète d'un Project vers une ressource côté Provider. 1 par (project, provider).                                               |
| **Role**            | Bundle nommé de permissions, **provider-scoped**, naming `<provider>:<role-name>`. Builtin v1 = `github:reader`, `github:developer`.       |
| **AccessToken**     | Identité project-scoped, porteur de N Roles, identifiée par une `api_key` Vaubaan (`vbn_live_xxxx…`). Usager agnostique (agent/script/humain). Optionnellement TTL via `expires_at`. |
| **ManagementKey**   | Bearer creds org-scoped (`vbn_mgmt_xxxx…`), inutilisable sur `/mcp`. Authentifie un client programmatique sur `/api/v1/mgmt/*` pour mint/révoquer des AccessTokens éphémères. |
| **Policy**          | Règle dans `Role.permissions.rules[]` : `{effect, tool/tool_matches, target?, constraints?, priority?}`.                                   |
| **MCPGateway**      | Endpoint Vaubaan `/mcp` en JSON-RPC. Auth via `Authorization: Bearer <api_key>`. C'est le hot-path produit.                                  |
| **AuditLog**        | Une row par MCP call : qui/quoi/décision/latence. Append-only via app, rétention 90j.                                                       |

### 2.3 L'invariant transverse — "l'agent ne voit jamais de cred provider"

> **Aucun token de Cloud Provider ne transite jamais vers l'agent.**

- Le Bot s'authentifie auprès du gateway avec son `api_key` Vaubaan
  (`vbn_live_xxxx…`), pas avec un token provider.
- Le gateway mint **JIT** un token éphémère côté Provider :
  - GitHub : installation token 1h via JWT signé avec la privkey de la
    GitHub App "Vaubaan Gateway" → `POST /app/installations/{id}/access_tokens`
  - Vercel : `access_token` long-lived issu du flow OAuth Integration
  - Supabase : `access_token` court (1h) issu d'un refresh dance OAuth Mgmt
- Le gateway utilise ce token pour l'appel upstream et le **libère immédiatement**
  de la mémoire après la réponse (pas de cache en clair persistant — sauf
  GitHub où on cache l'installation token 50min en Redis pour limiter le
  round-trip de mint).
- L'agent reçoit la réponse MCP du provider (qui peut contenir des données :
  contenu de fichier, status de PR…) mais **jamais** un token utilisable
  hors du gateway.
- Si un Bot exfiltre son `api_key`, l'attaquant n'obtient *que* les droits
  de ce Bot (révocable instantanément). Aucun cred long-lived côté Provider
  n'est compromis.

Toute action gateway requiert un Bot authentifié. Une action interrompue
ne laisse aucun state intermédiaire : un MCP call est atomique
(auth → policy → mint → dispatch → audit → return).

## 3. Modèle de données

### 3.1 Tables

```sql
-- Tables Supabase Auth existantes : auth.users.

create table organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique check (slug ~ '^[a-z0-9](-?[a-z0-9])*$'),
  owner_id      uuid not null references auth.users(id),
  created_at    timestamptz not null default now()
);

-- Trigger : un owner est toujours member de son org.
-- enforce_owner_is_member() s'exécute après INSERT/UPDATE de owner_id.

create table org_members (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  added_at        timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table provider_admins (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organizations(id) on delete cascade,
  provider                 text not null check (provider in ('github', 'vercel', 'supabase')),
  status                   text not null default 'connected'
                              check (status in ('connected', 'expired', 'revoked')),
  -- Tokens stockés chiffrés at-rest (Supabase Vault, KMS-géré, jamais accessible à l'app).
  installation_id          text,                       -- github
  team_id                  text,                       -- vercel
  access_token_encrypted   bytea,                      -- vercel + supabase
  refresh_token_encrypted  bytea,                      -- supabase
  expires_at               timestamptz,                -- supabase
  connected_by_user_id     uuid references auth.users(id),
  connected_at             timestamptz not null default now(),
  unique (organization_id, provider)
);

create table projects (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null,
  slug            text not null check (slug ~ '^[a-z0-9](-?[a-z0-9])*$'),
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  unique (organization_id, slug)
);

create table provider_bindings (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  provider      text not null check (provider in ('github', 'vercel', 'supabase')),
  resource_ref  text not null,
                  -- github:  'owner/repo'
                  -- vercel:  'prj_xxx'
                  -- supabase: '<project_ref>' (xxx.supabase.co)
  display_name  text,
  created_at    timestamptz not null default now(),
  unique (project_id, provider)
);

create table roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
                      -- null = builtin global
  provider        text not null check (provider in ('github', 'vercel', 'supabase')),
  name            text not null check (name like provider || ':%'),
  description     text,
  is_builtin      boolean not null default false,
  permissions     jsonb not null,
                      -- {version: 1, rules: [{effect, tool?, tool_matches?,
                      --                       target?, constraints?, priority?}]}
  created_at      timestamptz not null default now(),
  unique (organization_id, name) nulls not distinct
);

create table access_tokens (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  name            text not null check (name ~ '^[a-z0-9](-?[a-z0-9])*$'),
  api_key_prefix  text not null,   -- 'vbn_live_AbCdEfGh' (16 chars visibles UI)
  api_key_hash    text not null,   -- argon2id(full api_key)
  status          text not null default 'active'
                      check (status in ('active', 'revoked')),
  last_used_at    timestamptz,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz,     -- NULL = pas de TTL ; sinon le gateway
                                   --       rejette quand now > expires_at
  unique (project_id, name)
);

-- ManagementKey : Bearer creds org-scoped, distinct des AccessTokens,
-- utilisé exclusivement pour authentifier les appels /api/v1/mgmt/*.
-- Inutilisable sur le MCP gateway. Cf. ADR [[programmatic-access-token-minting]].
create table org_management_keys (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null check (name ~ '^[a-z0-9](-?[a-z0-9])*$'),
  api_key_prefix  text not null unique,   -- 'vbn_mgmt_AbCdEfGh'
  api_key_hash    text not null,           -- argon2id(full api_key)
  status          text not null default 'active'
                      check (status in ('active', 'revoked')),
  last_used_at    timestamptz,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  unique (organization_id, name)
);

create table access_token_roles (
  access_token_id uuid not null references access_tokens(id) on delete cascade,
  role_id         uuid not null references roles(id) on delete restrict,
  added_at        timestamptz not null default now(),
  primary key (access_token_id, role_id)
);

create table audit_log (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references organizations(id) on delete cascade,
  project_id            uuid references projects(id) on delete set null,
  access_token_id       uuid references access_tokens(id) on delete set null,
  ts                    timestamptz not null default now(),
  tool_name             text not null,
  arguments_hash        text not null,  -- sha256(JSON.stringify(args)).slice(0, 16)
  role_matched          text,           -- role.name qui a allow ; null si denied
  decision              text not null check (decision in ('allowed', 'denied')),
  denial_reason         text,
  upstream_latency_ms   int,
  client_ip             inet,
  client_user_agent     text
);
```

### 3.2 Indices clés

- `provider_admins (organization_id, provider)` — UNIQUE, lookup direct au hot-path.
- `provider_bindings (project_id, provider)` — UNIQUE.
- `roles (organization_id, name)` — UNIQUE nulls not distinct (sépare builtin
  global vs custom org-level).
- `access_tokens (api_key_prefix)` — fast lookup au moment de l'auth (puis vérifier hash).
- `access_tokens (project_id)` — listing UI.
- `access_tokens (expires_at) where expires_at is not null` — partial index pour
  les purges de tokens expirés (mgmt-minted).
- `access_token_roles (access_token_id)` — lookup roles d'un access_token au hot-path.
- `org_management_keys (api_key_prefix)` — UNIQUE, fast lookup au moment de
  l'auth /api/v1/mgmt/* (puis vérifier hash).
- `org_management_keys (organization_id)` — listing UI.
- `audit_log (organization_id, ts desc)` — historique org.
- `audit_log (access_token_id, ts desc)` — historique access_token.
- `audit_log (decision, ts desc) where decision='denied'` — partial index pour
  les anomalies (dashboard alerting).

### 3.3 RLS — résumé

**Membership plat + owner protégé.** Cf. ADR [[flat-membership-org-owner-access-token]].
Tout member a un accès RW complet sur le contenu de l'org. L'owner unique
(`organizations.owner_id`) a les mêmes droits + il est protégé contre la
suppression depuis `org_members` (transfert préalable via
`POST /api/v1/orgs/:slug/transfer-ownership` requis).

| Table                | member | owner |
| -------------------- | :----: | :---: |
| `organizations`      |   RW   |  RW   |
| `org_members`        |  RW¹   |  RW¹  |
| `provider_admins`    |   RW   |  RW   |
| `projects`           |   RW   |  RW   |
| `provider_bindings`  |   RW   |  RW   |
| `roles`              |   RW²  |  RW²  |
| `access_tokens`      |   RW   |  RW   |
| `access_token_roles` |   RW   |  RW   |
| `org_management_keys`|   RW   |  RW   |
| `audit_log`          |   R    |   R   |

¹ DELETE refusé si la cible est l'owner ; l'UPDATE de `organizations.owner_id`
est restreint à l'owner courant (transfert d'ownership).
² Les Roles builtin (`organization_id IS NULL`) restent read-only ; seuls les
custom org-scoped sont éditables par les members.

`audit_log` est strictement append-only depuis l'app (aucun UPDATE/DELETE
exposé). Purge nightly par job admin programmé (rétention 90j en v1).

`api_key_hash` n'est jamais lu par l'app web — seul le service d'auth du
gateway le lit, avec un service_role key séparé.

## 4. Architecture & Trust Model

### 4.1 Le double plan d'accès

Pour qu'un porteur d'AccessToken exécute un appel upstream, **deux gates
indépendantes** doivent être franchies :

| Plan              | Mécanisme                                       | Tenu par           | Bloque…                              |
| ----------------- | ----------------------------------------------- | ------------------ | ------------------------------------ |
| **Plan Auth**     | Auth `api_key` de l'AccessToken                 | Gateway Vaubaan    | l'authentification du porteur        |
| **Plan Policy**   | Évaluation des Roles attachés à l'AccessToken   | Policy engine      | l'autorisation de l'appel            |

Si l'`api_key` est invalide → 401. Si les Roles n'autorisent pas
le `(tool, args)` → JSON-RPC error avec `denial_reason` actionable.

### 4.2 Trust model — IdP-style

Vaubaan Core est **un IdP de confiance** dans la chaîne :

- L'org admin connecte un ProviderAdmin = il donne à Vaubaan Core le pouvoir
  d'agir à sa place chez le Provider.
- Modèle équivalent à Okta / Auth0 (SSO orchestre l'identité), Cloudflare
  Access (proxy zéro-trust), Stripe Connect (Stripe détient des tokens
  marchand au nom des plateformes).

Implications :

- L'opérateur Vaubaan a accès en clair aux tokens provider en mémoire
  d'exécution. Vaubaan Core doit être opéré avec les pratiques d'un IdP
  critique : audits (SOC2-style dès v1.5), access logs immutables,
  rotation des secrets app, isolation des envs.
- Si Vaubaan Core est compromis, **tous les ProviderAdmins de toutes les
  Orgs sont compromis**. Mitigations :
  - Encryption at-rest via KMS séparée (Supabase Vault — la KEK n'est pas
    accessible à l'app)
  - Audit log immutable (DB-side append-only)
  - Rotation périodique des secrets de l'app Vaubaan (App private keys,
    OAuth client secrets, encryption keys)

### 4.3 Hot-path multi-tenant

Le gateway `/mcp` est le **hot-path** : toutes les requêtes d'agents
passent par lui.

- **Stateless** : chaque call MCP est self-contained. Pas de session côté
  gateway, juste lookup `api_key`.
- **Cache Redis** : `(api_key_prefix → access_token+project+roles+bindings+provider_admin)`
  cached 60s pour éviter le N+1 sur la DB. Invalidation explicite sur
  `PATCH access_tokens`, `DELETE access_tokens`, `PATCH access_token_roles`,
  `PATCH provider_admins`, `PATCH roles`, `PATCH provider_bindings`.
- **Latence cible** : p50 < 50ms côté gateway (auth + policy + cache lookup) +
  latence upstream provider. p99 < 200ms hors upstream.
- **Throughput cible MVP** : 1 instance Vercel serverless (~1000 req/s par
  instance). Scaling horizontal automatique.

### 4.4 Storage des ProviderAdmin tokens

- **KMS** : Supabase Vault (`vault.create_secret(...)`, `vault.decrypted_secrets`
  view). KEK gérée par Supabase, jamais accessible à l'app Vaubaan.
- **Pas de multi-recipient** : 1 seul "recipient" logique = l'app Vaubaan.
- **Rotation** :
  - GitHub : pas de rotation programmée. La privkey de la GitHub App est
    long-lived ; les installation tokens sont éphémères (1h) et mintés JIT.
  - Vercel : pas de rotation programmée. L'user peut révoquer + reconnect
    pour rotater.
  - Supabase : refresh token rotaté automatiquement à chaque refresh
    (selon OAuth spec) ; access_token éphémère.

### 4.5 Minting de tokens upstream

À chaque call autorisé, le gateway génère un token éphémère côté Provider :

| Provider  | Mint                                                                 | Cache Redis  |
| --------- | -------------------------------------------------------------------- | ------------ |
| GitHub    | `POST /app/installations/{id}/access_tokens` signé JWT (privkey App) | 50min        |
| Vercel    | use `access_token_encrypted` direct                                  | 60s          |
| Supabase  | si `expires_at - now < 5min` → refresh dance ; sinon use access      | jusqu'à exp  |

Le token est utilisé pour le call upstream et **libéré immédiatement** de
mémoire après la réponse (pas de cache en clair persistant).

### 4.6 Sidecar MCP upstream

Stratégie d'intégration upstream à arbitrer en Phase 3 :

- **Option A** — Synthétiser les responses MCP nous-mêmes en tapant
  directement l'API REST du provider. Contrôle fin sur les tools exposés,
  pas de dépendance à un binaire upstream.
- **Option B** — Lancer le MCP server officiel du provider (`ghcr.io/github/github-mcp-server`)
  en sidecar containerisé sur Vercel Functions ou Fly Machines. Moins de
  code à maintenir mais plus de surface ops.

**Décision MVP** : Option A pour GitHub (Octokit + synthèse MCP via la
spec MCP officielle). Vaubaan garde le contrôle de la liste des tools
exposés et de leur shape.

## 5. Catalogue providers + Roles builtin

### 5.1 Contrat `ProviderAdapter`

Le catalogue vit dans `@vaubaan/gateway-providers` :

```ts
type Provider = 'github' | 'vercel' | 'supabase' | 'railway';

interface ProviderAdapter {
  readonly provider: Provider;

  /** Génère l'URL de redirection vers l'écran de consent du provider. */
  authorizationUrl(orgId: string, returnUrl: string, state: string): string;

  /** Callback du flow OAuth/App install. Persiste un ProviderAdmin row. */
  handleCallback(orgId: string, params: URLSearchParams): Promise<ProviderAdmin>;

  /** Génère un token upstream éphémère à utiliser pour un call MCP. */
  mintUpstreamToken(admin: ProviderAdmin): Promise<{ token: string; expiresAt: Date }>;

  /** Valide qu'un resource_ref est accessible avec l'admin de l'org. */
  validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<{ ok: boolean; displayName?: string; error?: string }>;

  /** Liste des tools MCP exposés par ce provider (pour `tools/list`). */
  readonly availableTools: readonly McpToolDeclaration[];

  /** Exécute un MCP call (synthétisé ou forwardé) avec le token éphémère. */
  executeCall(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;

  /** Résout un target abstrait (`project.repos`) en valeurs concrètes. */
  resolveTarget(target: string, bindings: ProviderBinding[]): string[];
}
```

### 5.2 Layout package

```
packages/providers/
  github/
    adapter.ts              # ProviderAdapter implementation
    app-install.ts          # OAuth flow + JIT JWT mint
    tools.ts                # availableTools array
    execute.ts              # synthèse MCP via Octokit
    roles/
      reader.ts             # github:reader
      developer.ts          # github:developer
  vercel/                   # rewrap mcp.vercel.com (paste/long-lived token)
  supabase/                 # synthesis via Management API
  railway/                  # rewrap mcp.railway.com (OAuth + 1h refresh)
    railway-adapter.ts      # RailwayAdapter — refresh on hot-path + forward
    execute.ts              # JSON-RPC forward to mcp.railway.com
    tools.ts                # availableTools from frozen upstream-tools.json
    upstream-tools.json     # 10 tools frozen from upstream
```

Deux styles d'adapter coexistent (cf. ADR `rewrap-official-mcps.md` +
`railway-rewrap-remote-mcp.md`) : **rewrap** (Vercel, Railway — forward JSON-RPC
au MCP officiel) et **synthesis** (GitHub, Supabase — appels SDK/API directs).

### 5.3 Roles builtin v1 (GitHub MVP)

#### `github:reader`

Read-only.

```jsonc
{
  "version": 1,
  "rules": [
    {
      "effect": "allow",
      "target": "project.repos",
      "tool_matches": [
        "github__list_*",
        "github__get_*",
        "github__search_*"
      ]
    }
  ]
}
```

#### `github:developer`

Read + writes sur branches `feature/*`, `fix/*`, `claude/*`. Ouvre des PRs
vers `main` depuis ces branches. Pas de merge, pas de delete.

```jsonc
{
  "version": 1,
  "rules": [
    {
      "effect": "allow",
      "target": "project.repos",
      "tool_matches": ["github__list_*", "github__get_*", "github__search_*"]
    },
    {
      "effect": "allow",
      "target": "project.repos",
      "tool_matches": ["github__create_or_update_file", "github__push_files"],
      "constraints": {
        "arguments.branch": { "match": ["feature/*", "fix/*", "claude/*"] }
      }
    },
    {
      "effect": "allow",
      "target": "project.repos",
      "tool": "github__create_branch",
      "constraints": {
        "arguments.branch": { "match": ["feature/*", "fix/*", "claude/*"] }
      }
    },
    {
      "effect": "allow",
      "target": "project.repos",
      "tool": "github__create_pull_request",
      "constraints": {
        "arguments.head": { "match": ["feature/*", "fix/*", "claude/*"] },
        "arguments.base": { "equals": "main" }
      }
    }
  ]
}
```

`github__delete_*` et `github__merge_pull_request` ne sont pas listés
dans les allows — default-deny les bloque. Avant 0009 il y avait un deny
cross-role explicite, retiré pour que multi-role = union d'allows.

#### Railway (rewrap — cf. ADR `railway-rewrap-remote-mcp.md`)

Rewrap de `mcp.railway.com` (10 tools : `whoami`, `list-projects`,
`create-project`, `list-services`, `list-deployments`, `get-status`,
`get-logs`, `redeploy`, `accept-deploy`, `railway-agent`). Auth : OAuth Auth app
`authorization_code` + PKCE, scopes `openid offline_access workspace:member`,
audience `resource=https://mcp.railway.com`. Token 1h refreshé sur le hot-path.
Seedés en migrations `0004_add_railway_provider.sql` (viewer + member),
`0008_add_railway_deployer_role.sql` (deployer), et patché par
`0009_drop_cross_role_denies.sql` (retire le deny cross-role `accept-deploy`
du member — multi-role = union d'allows).

`railway:viewer` — read-only.

```jsonc
{
  "version": 1,
  "rules": [
    {
      "effect": "allow",
      "target": "*",
      "tool_matches": ["railway__whoami", "railway__list-*", "railway__get-*"]
    }
  ]
}
```

`railway:member` — read + create/redeploy/agent. Ne couvre pas
`accept-deploy` (default-deny suffit, plus de deny cross-role explicite
depuis 0009).

```jsonc
{
  "version": 1,
  "rules": [
    {
      "effect": "allow",
      "target": "*",
      "tool_matches": ["railway__whoami", "railway__list-*", "railway__get-*"]
    },
    {
      "effect": "allow",
      "target": "*",
      "tool_matches": ["railway__create-project", "railway__redeploy", "railway__railway-agent"]
    }
  ]
}
```

`railway:deployer` — read + commit-staged-and-deploy sur project bindé. Aucun
`create-project`, aucun `railway-agent`. Composable avec `railway:member`
(les droits s'additionnent depuis 0009 — checker les deux donne `member` +
`accept-deploy`).

```jsonc
{
  "version": 1,
  "rules": [
    {
      "effect": "allow",
      "target": "project.railway",
      "tool_matches": [
        "railway__whoami",
        "railway__list-*",
        "railway__get-*",
        "railway__accept-deploy"
      ]
    }
  ]
}
```

#### `github:provisioner` (migration 0005, internal)

Mint exclusivement `github__mint_install_token` avec `purpose=clone`. Utilisé
au bootstrap d'une session pour minter un token court-vivant scopé clone-only
sur les repos du Project. **Ne pas assigner à des humains.** Cf. ADR
`mint-install-token-credential`.

```jsonc
{
  "version": 1,
  "rules": [
    {
      "effect": "allow",
      "tool": "github__mint_install_token",
      "constraints": {
        "arguments.purpose": { "equals": "clone" }
      }
    }
  ]
}
```

`github:developer` est étendu par la migration 0005 pour autoriser le même
tool avec `purpose IN ('clone', 'push')` — l'agent push avec ce rôle.

#### Phase 5+ (catalogue prévu)

- `github:reviewer` — read + comment/approve PR, pas d'edit code
- `vercel:viewer` — read deploys/logs/env vars
- `vercel:editor` — read + update project settings (root directory,
  framework, build commands…) + upsert env vars sur projets bindés (pas
  de deploy) — shipped via migration 0006
- `vercel:deployer` — trigger deploys + read logs (pas d'edit env vars)
- `supabase:reader-staging` — read-only SQL staging, no DDL
- `supabase:writer-staging` — read/write SQL staging, no DDL
- `supabase:reader-prod` — read-only SQL prod (audit-heavy)

## 6. Policy engine & DSL

### 6.1 Schéma DSL

```ts
interface Permissions {
  version: 1;
  rules: Rule[];
}

interface Rule {
  effect: 'allow' | 'deny';
  /** Target abstrait résolu via les bindings du project du bot.
   *  Defaults à '*' (wildcard). */
  target?: 'project.repos' | 'project.vercel' | 'project.supabase' | '*';
  /** Exact tool name. */
  tool?: string;
  /** Glob patterns (au moins un de tool/tool_matches doit être présent). */
  tool_matches?: string[];
  /** Contraintes sur les arguments (dot-path → operator). */
  constraints?: Record<string, Constraint>;
  /** Tie-break entre rules qui matchent toutes (default 100). */
  priority?: number;
}

type Constraint =
  | { equals: string | number | boolean }
  | { in: (string | number)[] }
  | { not_in: (string | number)[] }
  | { match: string[] }              // glob (minimatch)
  | { regex: string }                // RegExp
  | { starts_with: string | string[] }
  | { not_starts_with: string | string[] };
```

### 6.2 Decision flow

```
1. Auth :
   - extract api_key du header Authorization: Bearer
   - parse prefix → lookup bot by api_key_prefix
   - verify argon2id hash → bot_id, project_id, org_id
   - si fail → 401

2. Load context (cached Redis 60s sur api_key_prefix) :
   - roles du bot (via bot_roles JOIN roles)
   - provider_bindings du project
   - provider_admins de l'org (par provider)

3. Parse MCP payload :
   - method = 'tools/call' → extract params.name (tool_name), params.arguments
   - method = 'tools/list' → renvoyer la liste filtrée (cf §7.2)
   - autre method MCP standard → forward selon protocol

4. Determine provider :
   - parse tool_name prefix : 'github__'/'vercel__'/'supabase__'
   - si org n'a pas de provider_admin pour ce provider → deny "provider not connected"

5. Évaluation policy :
   a. default = deny
   b. pour chaque role du bot dont role.provider matche le tool :
        pour chaque rule du role.permissions.rules :
          - check tool match (exact ou tool_matches glob)
          - check target match (résolu via provider_bindings)
          - check constraints (par dot-path dans arguments)
          - si rule matche et effect='allow' → tentative_allow = role
          - si rule matche et effect='deny'  → final_deny = rule (priority)
   c. Final : deny gagne toujours sur allow (deny override). Entre deux deny,
      priority gagne (default 100). Entre deux allow, premier match gagne.

6. Si denied :
   - return JSON-RPC error -32603 avec denial_reason actionable
   - audit_log row { decision: 'denied', role_matched: null, denial_reason }

7. Si allowed :
   - mintUpstreamToken via le ProviderAdapter de l'org
   - call adapter.executeCall(admin, binding, tool, args)
   - mesure upstream_latency_ms
   - audit_log row { decision: 'allowed', role_matched: role.name, upstream_latency_ms }
   - return JSON-RPC result au bot
```

### 6.3 Format d'erreur retournée à l'agent

Le message doit être **actionable** pour que l'agent (Claude Code, Cursor,
etc.) puisse se corriger seul. C'est un signal différenciant fort — le
proxy devient un *trainer*, pas juste un mur.

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32603,
    "message": "Vaubaan policy denied: branch 'main' is not allowed by role 'github:developer'. Allowed patterns: feature/*, fix/*, claude/*. Suggestion: 'git checkout -b feature/<name>' before retrying."
  }
}
```

Forme générique : `{policy_origin}: {what_failed}. {allowed_or_constraint}. {suggestion}`.

### 6.4 Resolution des targets abstraits

Les rules peuvent référencer des targets abstraits qui résolvent via les
`provider_bindings` du Project du Bot :

| Target              | Résolution                                                |
| ------------------- | --------------------------------------------------------- |
| `project.repos`     | `[binding.resource_ref]` du provider_binding 'github'     |
| `project.vercel`    | `[binding.resource_ref]` du provider_binding 'vercel'     |
| `project.supabase`  | `[binding.resource_ref]` du provider_binding 'supabase'   |
| `*`                 | wildcard, matche n'importe quel target                     |

Le check target se fait sur les arguments du call. Pour GitHub : on construit
`<arguments.owner>/<arguments.repo>` et on vérifie qu'il est dans la liste
résolue. Pour Vercel/Supabase : on check `arguments.project_id` ou équivalent.

Un call dont les arguments ne correspondent à aucun binding résolu → **deny implicite**
(la rule ne matche pas) → comme aucune autre allow ne matche, default deny.

### 6.5 Opérateurs

| Op                  | Sémantique                                                   |
| ------------------- | ------------------------------------------------------------ |
| `equals: x`         | `String(value) === String(x)`                                |
| `in: [...]`         | `[...].map(String).includes(String(value))`                  |
| `not_in: [...]`     | `!in([...])`                                                 |
| `match: [...]`      | OR sur `minimatch(value, pattern)` pour chaque pattern       |
| `regex: '...'`      | `new RegExp(pattern).test(value)`                            |
| `starts_with: x`    | `value.startsWith(x)` ; si array, OR                         |
| `not_starts_with`   | l'opposé                                                     |

Tous les checks string-coerce les valeurs avant comparaison. Les valeurs
manquantes (`undefined` dans `arguments`) matchent à `false` sur tous les
opérateurs sauf `not_in` / `not_starts_with` (où elles matchent à `true`).

## 7. MCP Gateway

### 7.1 Endpoint

```
POST /mcp HTTP/1.1
Host: vaubaan.com
Authorization: Bearer vbn_live_abc123def456...
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "github__create_or_update_file",
    "arguments": {
      "owner": "acme",
      "repo": "app",
      "branch": "feature/x",
      "path": "README.md",
      "content": "...",
      "message": "..."
    }
  },
  "id": 42
}
```

### 7.2 Discovery (`tools/list`)

Le gateway répond à `tools/list` en énumérant **uniquement les tools que
le token peut potentiellement appeler** :

```
allowed_tools(token) = ⋃ provider {
  tool ∈ provider.availableTools |
    ∃ s ∈ provider.toolCapabilities(tool) ·
      isToolPotentiallyCallable(token.capabilities, [s], provider.toolEnvResolution(tool))
}
```

Filtrage statique — pas d'évaluation des args. Le prédicat
`isToolPotentiallyCallable` switche sur le `EnvResolution` du tool (cf.
[gateway-capability-model.md §7.1](./gateway-capability-model.md#71-filtre-statique--filtre-runtime-modulo-envresolution)) :

- tools **env-static** → match strict 5-tuple incl. env (un grant
  `cap@env` ne couvre pas un requirement env-less, et inversement).
- tools **env-runtime** → match 4-tuple, env-defensive filter au call.

Cette dichotomie garantit que `callable: true` dans le catalog
(§7.6) ⇒ pas de 403 surprise à `tools/call` pour un mismatch d'env.

### 7.3 Streaming

MCP supporte des responses streamées (Server-Sent Events) pour les outputs
longs (logs de deploy, listings volumineux). Le gateway forwarde le stream
upstream sans modification — la policy a déjà été évaluée *avant* le
start du stream.

### 7.4 Dispatch upstream (Option A — synthèse)

Le gateway implémente l'exécution MCP en tapant directement l'API REST
du Provider via le SDK officiel (Octokit pour GitHub). Avantages :

- Contrôle fin de la liste des tools exposés
- Pas de sidecar containerisé à opérer
- Possibilité de filtrer / enrichir les réponses (ex: stripper des champs sensibles)

Le mapping `tool_name → SDK call` vit dans `packages/providers/<provider>/tools.ts`
et `execute.ts`. Tests unitaires obligatoires par tool pour valider le
mapping et les error cases.

### 7.5 Erreur upstream

Si l'appel upstream échoue (rate limit, network, 5xx provider), le gateway :

- Audit la row avec `decision: 'allowed'` (le call a été *autorisé*, juste
  pas exécuté avec succès) + `denial_reason: null` + `upstream_latency_ms`
- Renvoie une JSON-RPC error -32603 avec le message du provider passé
  intact (sauf si secret leakage suspect → strip)

### 7.6 Catalog discovery (`GET /api/v1/catalog`)

Endpoint Bearer-authentifié, séparé de `/mcp`, qui retourne la **surface
complète** des tools + ce que le token peut callable. Sert deux clients :

- `Bearer vbn_live_…` → catalog scopé au projet du token, avec `callable` +
  `missingCapabilities` par tool + `auth.bindings` (les refs amont du
  projet).
- `Bearer vbn_mgmt_…` → catalog org-wide, sans `callable` ni `bindings`
  (un mgmt key n'est pas scopé à un projet et peut mint n'importe quoi
  modulo policy gate).

Forme de la réponse (mode `live`) :

```jsonc
{
  "auth": {
    "kind": "live",
    "organization": { "id": "...", "slug": "...", "name": "..." },
    "project":      { "id": "...", "slug": "..." },
    "granted":      ["vercel:deployment:read", "supabase:db/rows:read@prod", ...],
    "bindings": {
      "vercel":   [{ "resourceRef": "prj_xxx",  "environment": null,   "displayName": "Web" }],
      "supabase": [{ "resourceRef": "abcd1234", "environment": "prod", "displayName": "Prod DB" }],
      "github":   [{ "resourceRef": "acme/app", "environment": null,   "displayName": null }]
    }
  },
  "providers": [
    {
      "slug": "vercel",
      "displayName": "Vercel",
      "tools": [
        {
          "name": "vercel__list_deployments",
          "requiredCapabilities": ["vercel:deployment:read"],
          "callable": true
        },
        {
          "name": "vercel__upsert_env_var",
          "requiredCapabilities": ["vercel:config:write"],
          "callable": false,
          "missingCapabilities": ["vercel:config:write"]
        }
      ]
    }
  ],
  "mintHint": { "endpoint": "/api/v1/mgmt/tokens", "method": "POST", ... }
}
```

**Contrats** :

- `auth.bindings` est groupé par slug provider. Chaque entrée carry le
  `resourceRef` que l'agent passera à `tools/call` (`projectId` pour
  Vercel, `project_ref` pour Supabase, `owner/repo` pour GitHub…) +
  l'`environment` du binding (null si la ressource n'est pas calquée par
  env, cf. capability-model §4). C'est l'**unique** source de discovery
  des refs amont — sans ce champ, l'agent n'a aucun moyen d'apprendre le
  ref qu'il doit citer (chicken-and-egg : le gateway *valide* le ref mais
  ne le divulguait pas).
- `callable` matche **exactement** ce que `tools/list` retourne — même
  prédicat `isToolPotentiallyCallable` (§7.2). Un tool listé `callable: true`
  ne 403e pas pour mismatch d'env ; il peut encore denied pour un env
  défensif si `EnvResolution = runtime` et le grant @env ne correspond pas
  à l'env résolu des args.
- `missingCapabilities` n'est posé que quand `callable: false` ; il
  enumere les caps à mint (n'importe laquelle suffit) pour débloquer.

## 8. API REST

Préfixe : `/api/v1`. Auth par session Supabase (cookie).

Le `/mcp` du gateway est un endpoint séparé, hors `/api/v1` (cf §7.1),
authentifié par `api_key` Bot.

### 8.1 Organizations + Members

```
POST   /orgs                              -- { name, slug } ; user creator → admin
GET    /orgs                              -- list orgs of current user
GET    /orgs/:orgId
PATCH  /orgs/:orgId                       -- admin
DELETE /orgs/:orgId                       -- admin, confirmation UI

GET    /orgs/:orgId/members
POST   /orgs/:orgId/members               -- { email, role }
PATCH  /orgs/:orgId/members/:userId       -- { role }
DELETE /orgs/:orgId/members/:userId
```

### 8.2 ProviderAdmins (OAuth/App install)

```
POST   /orgs/:orgId/providers/:provider/connect
       -> 200 { authorization_url, state }   -- redirection à effectuer côté browser
GET    /orgs/:orgId/providers/:provider/callback?...
       -- callback handler ; verify state, exchange code, persist row
GET    /orgs/:orgId/providers
       -- list connected, avec status
DELETE /orgs/:orgId/providers/:provider
       -- revoke ProviderAdmin (cascading deny sur tous les calls de bots
          dont l'org dépend de ce provider)
```

### 8.3 Projects + Bindings

```
POST   /orgs/:orgId/projects                                    -- { name, slug }
GET    /orgs/:orgId/projects
GET    /orgs/:orgId/projects/:projectId
PATCH  /orgs/:orgId/projects/:projectId
DELETE /orgs/:orgId/projects/:projectId

POST   /orgs/:orgId/projects/:projectId/bindings
       -- { provider, resource_ref } ; Vaubaan valide via adapter.validateBinding
GET    /orgs/:orgId/projects/:projectId/bindings
PATCH  /orgs/:orgId/projects/:projectId/bindings/:bindingId     -- { resource_ref }
DELETE /orgs/:orgId/projects/:projectId/bindings/:bindingId
```

### 8.4 Roles

```
GET    /orgs/:orgId/roles                  -- list builtin + custom
GET    /orgs/:orgId/roles/:roleId
POST   /orgs/:orgId/roles                  -- custom only (v2)
PATCH  /orgs/:orgId/roles/:roleId          -- custom only (v2)
DELETE /orgs/:orgId/roles/:roleId          -- custom only (v2)
```

### 8.5 Bots

```
POST   /orgs/:orgId/projects/:projectId/bots
       -- { name, roles: [roleId] }
       -- returns { bot, api_key } ; api_key visible **1 seule fois**
GET    /orgs/:orgId/projects/:projectId/bots
GET    /orgs/:orgId/projects/:projectId/bots/:botId
PATCH  /orgs/:orgId/projects/:projectId/bots/:botId
       -- { name, roles, status }
POST   /orgs/:orgId/projects/:projectId/bots/:botId/rotate-key
       -- returns { api_key } ; ancienne invalidée immédiatement
DELETE /orgs/:orgId/projects/:projectId/bots/:botId
```

### 8.6 Audit

```
GET    /orgs/:orgId/audit?bot=...&project=...&decision=...&since=...&limit=...
GET    /orgs/:orgId/audit/:auditId
GET    /orgs/:orgId/audit/stats?since=...  -- counts par decision/role/bot/day
```

### 8.7 Catalog (lecture-seule, public-ish)

```
GET    /catalog/providers                   -- liste { provider, status: 'mvp'|'phase5' }
GET    /catalog/roles                       -- liste roles builtin
GET    /catalog/tools?provider=...          -- availableTools par provider
```

### 8.8 ManagementKeys + Management API (programmatic AccessToken minting)

Cf. ADR [[programmatic-access-token-minting]].

```
GET    /orgs/:slug/management-keys                 -- list (admin/member)
POST   /orgs/:slug/management-keys                 -- { name } ; returns { management_key, api_key }
                                                   --   api_key visible 1× (argon2id at-rest)
DELETE /orgs/:slug/management-keys/:keyId          -- hard delete
```

```
GET    /api/v1/mgmt/roles
       Authorization: Bearer vbn_mgmt_…
       returns 200 { roles: [{ id, name, provider, description, is_builtin }] }

GET    /api/v1/mgmt/projects
       Authorization: Bearer vbn_mgmt_…
       returns 200 {
         projects: [{
           id, slug, name, created_at,
           bindings: [{ provider, resource_ref, display_name }]
         }]
       }

POST   /api/v1/mgmt/tokens
       Authorization: Bearer vbn_mgmt_…
       body: { projectSlug, roleIds, name?, ttlHours? }
       returns 201 { access_token, api_key, expires_at }

DELETE /api/v1/mgmt/tokens/:tokenId
       Authorization: Bearer vbn_mgmt_…
       returns 200 { ok: true } | 404 if token not in bound org
```

`GET /mgmt/roles` retourne les builtin globaux **plus** les roles custom
de l'org liée à la management key — c'est la liste actionable pour les
`roleIds[]` du `POST /mgmt/tokens`. `GET /mgmt/projects` retourne les
projects de l'org avec leurs bindings pour permettre au client de découvrir
les `projectSlug` valides et savoir quels providers sont activés sur chacun.

Default `ttlHours=24`, hard-cap **168h** (7j). Tout AccessToken émis ici porte
un `expires_at` que le hot-path gateway respecte (`AuthError('access token
has expired.')` quand `now > expires_at`). Le client appelle `POST /mgmt/tokens`
au début de chaque session, stocke l'`api_key` localement pour la durée de la
session, et peut appeler `DELETE /mgmt/tokens/:id` à la fin pour cleanup
explicite. Les tokens oubliés sont purgés serveur-side 7 jours après leur
`expires_at` (cf. migration `0010_purge_expired_access_tokens.sql`).

## 9. Workflows

### 9.1 Onboarder une nouvelle Organization

```
1. User → signup Vaubaan (magic-link Supabase Auth)
2. User → POST /orgs { name: 'Acme', slug: 'acme' } → 201 ; user devient admin
3. UI propose "Connect a Cloud Provider"
4. User clic "Connect GitHub" :
   - UI → POST /orgs/acme/providers/github/connect → { authorization_url, state }
   - browser redirect vers https://github.com/apps/vaubaan-gateway/installations/new
5. GitHub écran consent : "Vaubaan Gateway veut accéder à votre org" → user
   choisit org + repos → "Authorize"
6. GitHub redirect callback : GET /providers/github/callback?installation_id=...&setup_action=install
7. Vaubaan : verify state, persist provider_admins row (status='connected',
   installation_id stored, connected_by_user_id = current user)
8. UI : "GitHub connected ✓. Now create a project."
```

### 9.2 Créer un Project + ProviderBinding

```
1. User (admin) → POST /orgs/acme/projects { name: 'Website', slug: 'website' }
2. User → POST /orgs/acme/projects/website/bindings
                { provider: 'github', resource_ref: 'acme/website' }
3. Vaubaan :
   - vérifie que l'org a un provider_admins github status='connected'
   - appelle adapter.validateBinding(admin, 'acme/website')
     → mint installation token JIT, GET /repos/acme/website
     → ok=true si 200 + display_name
   - persiste provider_bindings row
4. UI : binding affiché dans la project page
```

### 9.3 Créer un Bot

```
1. User → POST /orgs/acme/projects/website/bots
                { name: 'claude-dev', roles: ['<id of github:developer>'] }
2. Vaubaan :
   - génère api_key = 'vbn_live_' + 32 chars random base62
   - persiste bots row { api_key_prefix: 'vbn_live_AbCdEfGh', api_key_hash: argon2id(api_key) }
   - persiste bot_roles row
3. Return { bot, api_key } -- l'api_key n'est visible **qu'à cette étape**
4. UI : modal "Copy this api_key now, it won't be shown again" + bouton Copy
5. User copie l'api_key dans son ~/.config/claude/mcp.json :
   "vauban": {
     "url": "https://vaubaan.com/mcp",
     "headers": { "Authorization": "Bearer vbn_live_AbCd...XyZ" }
   }
```

### 9.4 Run d'un agent (hot-path)

```
1. Claude Code envoie JSON-RPC tools/list au gateway
   → Gateway : auth(api_key) → bot, project, org, roles
              → response { tools: [tools potentiellement allowés par les roles] }
2. Claude envoie tools/call name=github__create_pull_request
                          args={ owner:'acme', repo:'website', head:'feature/x', base:'main', title:'...' }
3. Gateway :
   - auth → cache hit (Redis 60s)
   - extract provider = 'github'
   - check provider_admin github status='connected' → ok
   - évalue policy : role 'github:developer' matche, rule 4 (create_pull_request
     allow head=feature/* base=main) → allowed
   - mint installation token JWT JIT
   - call adapter.executeCall(admin, binding, 'github__create_pull_request', args)
     → Octokit POST /repos/acme/website/pulls
     → PR créée côté GitHub, audit GitHub-side : actor = Vaubaan Gateway[bot]
   - mesure upstream_latency_ms = 247
   - audit_log row { decision: 'allowed', role_matched: 'github:developer',
                     upstream_latency_ms: 247 }
   - return JSON-RPC result { ok: true, pr_number: 123, pr_url: '...' }
4. Claude reçoit la confirmation et continue
```

### 9.5 Denied call (et auto-correction de l'agent)

```
1. Claude (par erreur) : tools/call name=github__push_files
                                    args={ ..., branch: 'main', ... }
2. Gateway :
   - évalue policy : rule "push files allow branch feature/*/fix/*/claude/*"
     ne matche pas (branch='main') ; aucune autre allow ne matche → denied
   - return JSON-RPC error : "Vaubaan policy denied: branch 'main' is not
     allowed by role 'github:developer'. Allowed: feature/*, fix/*, claude/*.
     Suggestion: 'git checkout -b feature/<name>' before retrying."
   - audit_log row decision=denied
3. Claude lit l'erreur, comprend, suggère à l'user "Je vais créer une branche
   feature/x d'abord", puis re-tente avec branch='feature/x' → allowed
```

### 9.6 Révocation et rotation

**Révoquer un Bot** :

```
1. Admin → PATCH /bots/:id { status: 'revoked' } (ou DELETE pour hard-delete)
2. Cache Redis invalidé (publish sur channel 'bot-invalidation')
3. Prochain call avec l'ancienne api_key → 401
```

**Rotater l'api_key d'un Bot** :

```
1. Admin → POST /bots/:id/rotate-key
2. Vaubaan génère nouvelle api_key, persiste nouveau hash + prefix
3. Return { api_key } -- visible 1×
4. Cache invalidé. L'ancienne api_key est immédiatement 401
5. User update son ~/.config/claude/mcp.json
```

**Révoquer un ProviderAdmin** :

```
1. Admin → DELETE /orgs/:orgId/providers/:provider
2. Vaubaan : provider_admins.status='revoked' (audit) + delete row
3. Cache Redis invalidé pour toute l'org
4. Tous les calls MCP de bots de cette org qui visent ce provider → denied
   avec "Provider <X> not connected for this org"
```

## 10. RBAC humain

**2 rôles au niveau Organization** : `member`, `admin`.

| Action                                           | member | admin |
| ------------------------------------------------ | :----: | :---: |
| Read Org / Members / Projects / Bots / Audit     |   ✅   |  ✅   |
| Create Project                                   |   ✅   |  ✅   |
| Edit/Delete own Project                          |   ✅   |  ✅   |
| Edit/Delete any Project                          |   ❌   |  ✅   |
| Connect/Revoke ProviderAdmin                     |   ❌   |  ✅   |
| Create/Edit/Delete ProviderBinding               |   ❌   |  ✅   |
| Create Custom Role (v2)                          |   ❌   |  ✅   |
| Create/Edit Bot, toggle Bot roles                |   ❌   |  ✅   |
| Rotate Bot api_key                               |   ❌   |  ✅   |
| Invite/Remove Member                             |   ❌   |  ✅   |
| Read Audit Log (own bots only)                   |   ✅   |  -    |
| Read Audit Log (all bots of org)                 |   ❌   |  ✅   |

Pas de granularité fine par-resource. La granularité fine vit dans la
**composition Roles × Bots** (qui est elle-même un objet d'admin).

## 11. Sécurité

- **No cleartext logs.** Les tokens upstream mintés ne loguent jamais leur
  valeur. Les `api_key` Vaubaan loguent uniquement leur `api_key_prefix`
  (16 premiers chars, suffisant pour identification, pas suffisant pour
  l'auth).
- **Encryption at-rest.** ProviderAdmin tokens chiffrés via Supabase Vault
  (KMS). KEK jamais accessible à l'app Vaubaan.
- **TLS only.** Vaubaan Core (Vercel) sert tout en TLS 1.2+. HSTS forcé.
  Le MCP gateway exige HTTPS dans le client.
- **Rate limits** (Upstash Redis sliding window) :
  - `/mcp` : 60 req/min par api_key, 600 req/min par org. Burst 10×.
  - `/api/v1/*` : 60 req/min par user.
  - `/orgs/:orgId/providers/:provider/connect` : 5 req/min par user (anti-fishing).
  - `/orgs/:orgId/providers/:provider/callback` : 5 req/min par IP (anti-replay).
- **Anti-replay sur OAuth callbacks** : `state` nonce stocké côté session
  Supabase 5min, single-use.
- **Anti-CSRF.** Toutes les mutations REST exigent un cookie `SameSite=Lax`
  Supabase + header `Origin` matching.
- **Audit immutable.** Aucun UPDATE/DELETE exposé sur `audit_log` depuis
  l'app. Purge nightly par job admin programmé (rétention 90 jours en v1).
  Stockage post-90j → tier cold (S3 Parquet) en v1.5+.
- **Pas de redirect open.** Le `returnUrl` du flow OAuth est validé contre
  une allowlist hard-codée (l'origin Vaubaan Core uniquement).
- **Subprocess sandboxing** non-applicable en v1 (pas de sidecar MCP en
  Option A). Si on switch en Option B en v1.5, le sidecar Docker tourne
  avec `--cap-drop=ALL --read-only --network=internal` + egress allowlist.

## 12. UX

### 12.1 Pages principales

- `/orgs/:slug` — dashboard org : counts projects, bots actifs, allowed/denied
  du jour, alertes (denied > N par bot par heure).
- `/orgs/:slug/providers` — list ProviderAdmins, status, dates de connect,
  qui a connecté. Bouton "Connect <Provider>".
- `/orgs/:slug/projects` — list projects + count bots actifs.
- `/orgs/:slug/projects/:name` — detail project : bindings, bots, audit récent
  (10 dernières rows).
- `/orgs/:slug/projects/:name/bindings/new` — wizard binding : pick provider
  → paste `resource_ref` (avec hint format) → live validation via
  `adapter.validateBinding` → save.
- `/orgs/:slug/projects/:name/bots/new` — wizard bot : input name → select
  roles (multiselect des builtin + custom) → "Create" → modal "Copy this
  api_key now" + bouton Copy + warning "won't be shown again".
- `/orgs/:slug/projects/:name/bots/:botId` — detail bot : roles toggle,
  rotate key button, audit du bot (paginated), bouton revoke.
- `/orgs/:slug/roles` — catalogue Roles (builtin + custom). Drill-down sur
  un role montre les rules en JSON formatté + description Markdown.
- `/orgs/:slug/audit` — filtrable par bot/project/decision/time. Chart simple
  "denied / allowed last 7 days".
- `/orgs/:slug/members` — admin only. Invite via email, change role, remove.

### 12.2 Patterns UX

- **Bot api_key visible 1× via modal.** Création réussie ⇒ modal centré
  affiche l'api_key complète, bouton Copy, message clair "Copy this api_key.
  After dismissing this dialog, only the prefix will be visible. You can
  rotate it (and revoke the old one) if you lose it." Pas de hide/reveal
  ultérieur — le hash en DB n'est pas réversible.
- **Provider connect = redirect.** Pas de paste-token. UI explicite : "We
  will redirect you to <Provider>. Click 'Authorize' on their screen to
  connect."
- **Audit denial banner.** Si > 10 denied par bot dans la dernière heure,
  banner orange sur la page bot : "10 policy denials in the last hour.
  Likely your agent is trying actions outside its role. Check the audit
  log."
- **Binding validation live.** Quand l'user paste `acme/repo`, on appelle
  immédiatement `validateBinding` côté backend (debounced 500ms). Affichage
  ✓/✗ live avec error message si problème (404 repo, no permission, etc.).

### 12.3 Style guide

Voir `docs/spec/style-guide.md` (gardé du repo v3 ; design tokens et UI
primitives toujours applicables avec Next.js + Tailwind v4).

## 13. Audit

Toute mutation REST + tout MCP call produit une row.

### 13.1 MCP calls

```jsonc
{
  "id": "...",
  "organization_id": "...",
  "project_id": "...",
  "bot_id": "...",
  "ts": "2026-05-22T10:00:00Z",
  "tool_name": "github__create_pull_request",
  "arguments_hash": "sha256:abcd1234efgh5678",
  "role_matched": "github:developer",
  "decision": "allowed",
  "upstream_latency_ms": 247,
  "client_ip": "1.2.3.4",
  "client_user_agent": "claude-code/1.0.0"
}
```

Pour les denied :

```jsonc
{
  "decision": "denied",
  "role_matched": null,
  "denial_reason": "branch 'main' is not allowed by any role (allowed patterns: feature/*, fix/*, claude/*)"
}
```

### 13.2 Mutations admin

Les mutations REST (`POST /providers/:p/connect`, `DELETE /bots/:id`,
`PATCH /bot_roles`, etc.) ne vont **pas** dans `audit_log` — elles ont
leur propre flux logging app-level + Supabase Realtime pour l'UI.

### 13.3 Rétention

90 jours en hot DB. Job nightly purge les rows > 90j. Pas d'archive
cold storage en v1 — à ajouter en v1.5 (S3 Parquet via Supabase Storage
ou export externe).

## 14. Tests

Trois couches.

### 14.1 Unit (Vitest)

- **Policy engine** :
  - Property tests des 7 opérateurs (equals, in, not_in, match, regex,
    starts_with, not_starts_with) sur des inputs strings + numbers.
  - Decision flow : default deny, allow match, deny override, priority
    tie-break, target resolution via bindings.
  - DSL parse : tout role.permissions valid → parse OK ; version != 1 → reject ;
    rule sans tool/tool_matches → reject ; constraint avec op inconnu → reject.
- **ProviderAdapter** :
  - `authorizationUrl` : URL bien formée pour chaque provider.
  - `handleCallback` : mock du provider, vérifier persistence provider_admins.
  - `mintUpstreamToken` : mock du provider, vérifier signature JWT (GitHub),
    refresh logic (Supabase).
  - `resolveTarget` : pour chaque target abstrait, résolution correcte
    selon bindings.
  - `executeCall` : mock du SDK provider (Octokit), vérifier mapping
    `tool_name → SDK call`.

### 14.2 Integration (Vitest + Supabase test container)

- API REST end-to-end **sans browser** : RLS, lifecycle complet
  Org → ProviderAdmin → Project → Binding → Role → Bot → audit_log.
- Mock provider adapters côté `mintUpstreamToken` + upstream MCP server
  (in-process fake).
- Cas RLS : member ne peut pas Connect ProviderAdmin (403), member peut
  créer Project, member ne peut pas modifier Project d'autrui (403), etc.
- Cas re-validation Bot api_key après rotate : ancienne → 401, nouvelle → 200.
- Cas cascade : DELETE provider_admins → calls MCP qui visent ce provider
  → 403 with reason "provider not connected".

### 14.3 E2E (Playwright) — **vrais clouds, zéro mock**

Posture "no-mock" comme v3. Org GitHub dédiée
(`sbw-vauban-test` ou équivalent) avec un repo `playground` créé à la main.

#### Modèle d'organisation côté provider

```
provider    | org/team/account                | creds dans .env.test
------------+---------------------------------+--------------------------------
github      | github.com/sbw-vauban-test      | GH_TEST_APP_PRIVATE_KEY
            |                                 | GH_TEST_APP_ID
            |                                 | GH_TEST_INSTALLATION_ID
vercel      | team vauban-e2e                 | (Phase 5)
supabase    | org vauban-e2e                  | (Phase 5)
```

#### Scénarios MVP (GitHub-only)

1. **Onboarding GitHub** — créer org Vaubaan → simuler callback OAuth GitHub
   App install (test mode, on injecte `installation_id` directement) →
   assert row `provider_admins` créée + status='connected'.
2. **Project + binding** — créer project → POST binding github
   `sbw-vauban-test/playground` → assert `validateBinding` returns ok=true
   live → row `provider_bindings` créée.
3. **Bot creation** — créer bot avec role=`github:developer` → assert
   api_key visible 1× dans le response body, prefix correct, hash non-null
   en DB.
4. **Allow flow** — Claude Code (instance Playwright headless avec extension
   MCP) configuré avec l'api_key → demande "open PR feature/test-1 with
   a README" → assert call MCP forwardé + PR créée côté GitHub avec
   `actor = Vaubaan Gateway[bot]` + audit_log row decision=allowed.
5. **Deny flow** — Claude demande "push directly to main" → assert JSON-RPC
   error avec denial_reason actionable + audit_log row decision=denied.
6. **Revocation** — rotate api_key → assert ancienne 401, nouvelle 200.
   Puis revoke bot → assert 401.

#### Sweeper

Cron nightly qui ratisse les PRs / branches / repos `vauban-e2e-*` >24h sur
GitHub. Exit 0/1/2/3 pour CI alerting selon nb orphelins trouvés.

#### Conventions

Ressources transitoires créées en test = nommées `vauban-e2e-<testfile-hash6>-<run-uuid8>`.
`.env.test` gitignored, maintenu localement, injecté en CI via GitHub
Actions Secrets.

### 14.4 Structural

- Test qui parse chaque Role builtin et valide le DSL contre Zod.
- Test qui vérifie que tous les `tool_matches` d'un Role `github:*` commencent
  par `github__`.
- Test qui vérifie que chaque ProviderAdapter livre les 7 méthodes du
  contrat §5.1 (TypeScript suffit, mais un test runtime guard contre les
  régressions de signature côté JS pure).

## 15. Plan de cutover (rip & replace dans ce repo)

Greenfield : aucune migration de données, aucun dual-write. La séquence :

1. **Spec OK** (ce document, validé en review).
2. **Phase 0 cleanup** : déjà fait (code + docs v3 supprimés par le user le
   2026-05-22). Reste à nettoyer : `package.json` (name, description, scripts
   orphelins), `playwright.config.ts`, `vercel.json`, `.github/workflows/`,
   `.mcp.json`, `.env*`. Tag git `v3-final` à poser avant Phase 2.
3. **Phase 1 spec ADRs** : drafter les 7 ADRs fondateurs (cf §16.3).
4. **Phase 2 bootstrap** :
   - Rename `package.json` → `@vaubaan/gateway`. Description / scripts
     refondus.
   - Fix `playwright.config.ts` (testDir = `packages/web/tests/e2e`).
   - Fix `vercel.json` (buildCommand workspace `@vaubaan/web`).
   - Nouveau workflow `.github/workflows/ci.yml` épuré. Supprimer
     `e2e-nightly.yml` legacy, `supabase-migrations.yml` à redrafter.
   - Nouvelle migration `0001_init.sql` (les 9 tables §3.1).
   - Scaffold `packages/{policy-engine, mcp-gateway, providers/github, web, shared}`.
5. **Phase 3 vertical slice GitHub** :
   - Enregistrer GitHub App "Vaubaan Gateway" (manuel via dashboard GitHub,
     opérateur Vaubaan).
   - Flow OAuth/App install + UI minimaliste (login, create org, connect
     GitHub, create project, bind repo, create bot).
   - MCP gateway endpoint `/mcp` avec auth + policy engine + executeCall.
   - 2 roles builtin (`github:reader`, `github:developer`).
   - E2E Playwright contre sbw-vauban-test.
6. **Phase 4 audit UI + observability** : page audit log, stats, alerting.
7. **Phase 5 Vercel + Supabase providers** : 2 OAuth flows + 4-5 nouveaux
   roles builtin + E2E élargi.

Pas de feature flag, pas de période de coexistence avec v3. v3 est déjà
mort dans ce repo.

## 16. Décisions figées et points restants

### 16.1 Décisions figées (référence rapide)

- **Topologie** : Vaubaan Core multi-tenant SaaS, pas d'agent côté client.
- **Surface MVP** : MCP only. CLI/SDK = v2 (MITM TLS proxy).
- **Modèle RBAC** : Org → Roles → Bots → Project. Naming `<provider>:<role-name>`.
- **Connect providers** : OAuth/App install. Pas de paste-token jamais.
- **Roles** : org-level catalog, builtin v1, custom v2.
- **Bots** : project-scoped, N roles, identifiés par api_key (`vbn_live_…`).
- **Management keys** : org-scoped (`vbn_mgmt_…`), inutilisables sur `/mcp`,
  utilisées par tout client programmatique pour mint/révoquer des AccessTokens
  éphémères via `/api/v1/mgmt/*` (TTL default 24h, max 7j). Cf. ADR
  [[programmatic-access-token-minting]].
- **DSL policy** : JSON déclaratif `jsonb`, 7 opérateurs (equals, in,
  not_in, match, regex, starts_with, not_starts_with).
- **Default deny** : un call non couvert par au moins une allow rule est denied.
- **Deny override allow** : entre deux rules matchant, deny gagne.
- **Trust model** : IdP-style. Vaubaan Core détient les tokens provider en
  clair en mémoire d'exécution, chiffrés at-rest via Supabase Vault.
- **GitHub App** : globale Vaubaan (1 App registered, installée par chaque org).
- **MVP roles builtin** : `github:reader`, `github:developer`.
- **Dispatch upstream** : Option A (synthèse via Octokit) pour MVP, Option B
  (sidecar Docker) reconsidérée en v1.5 si besoin.
- **Rétention audit** : 90 jours en hot DB, purge nightly. Cold storage v1.5+.

### 16.2 Points encore ouverts

- **Auth user Vaubaan** : Supabase Auth magic-link confirmé. Google OAuth
  en v1.5 (low cost).
- **GitHub App globale vs per-org** : globale en MVP. Reconsidérer per-org
  en v2 si demande regulated (banking, etc.). ADR nécessaire si on switch.
- **Redis instance** : Upstash via Vercel Marketplace (default), ou Supabase
  Realtime PG-channels si on veut éviter une dépendance externe.
  À arbitrer en Phase 2 selon perf measurements.
- **Sidecar MCP** : Option A retenue MVP. Si la maintenance du mapping
  `tool_name → Octokit call` devient pénible (~50+ tools), reconsidérer
  Option B. ADR si switch.
- **Tools MCP exposés** : sous-ensemble du MCP GitHub officiel à figer
  en Phase 3. Pas tous les tools — uniquement ceux pertinents pour
  coding agents (~15-20 tools).
- **Custom roles UI** : v2. En MVP les 2 builtin + invitation à demander
  des roles via support / issue GitHub.
- **Stateful policy checks** (precondition upstream call) : Phase 5+ si
  besoin (ex: "CI verte avant merge").
- **Sweeper E2E** : à designer en Phase 3 selon ressources créées par
  les scénarios.
- **Onboarding tout premier user d'une org** : le créateur est admin par
  construction. Pas de cas dégénéré.

### 16.3 ADRs fondateurs à drafter (Phase 1)

- `pivot-v3-to-v4-policy-gateway` — motivations + ce qui change.
- `rbac-org-role-bot-project` — modèle d'autorisation.
- `roles-naming-provider-scoped` — `<provider>:<role-name>` convention.
- `mcp-only-mvp-scope` — pas de CLI/SDK proxy en MVP.
- `oauth-app-install-per-provider` — pas de paste-token, OAuth uniquement.
- `trust-model-clear-at-rest-idp-style` — abandon ZK, modèle de confiance.
- `policy-dsl-declarative-jsonb` — choix du DSL, 7 opérateurs.
- `dispatch-upstream-option-a-synthese` — pas de sidecar Docker MVP.

---

_Date : 2026-05-22. Auteur : rpelissier + Claude (drafting). Statut :
draft pour review._
