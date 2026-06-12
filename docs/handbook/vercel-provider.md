---
title: Vercel provider adapter
status: current
date: 2026-06-11
tracks:
  - packages/providers/vercel/src/
  - packages/web/src/app/api/integrations/vercel/
---

# Vercel provider — `@vaubaan/providers-vercel`

Rewrap du MCP remote officiel `mcp.vercel.com` (18 tools) augmenté de 4 tools
REST custom (`update_project_settings`, `upsert_env_var`, `list_env_vars`,
`delete_env_var`) qui couvrent les trous read/write du MCP officiel sur env
vars + project settings. Auth = Bearer long-lived (token d'Integration
`vca_*` ou PAT `vcp_*`), pas de refresh, scoping par `teamId` auto-injecté
côté adapter.

ADRs opérantes : `docs/decisions/rewrap-official-mcps.md`,
`docs/decisions/vercel-augment-with-rest-tools.md`,
`docs/decisions/oauth-app-install-per-provider.md`,
`docs/decisions/provider-onboarding-handbook-template.md`,
`docs/decisions/use-context7-for-provider-docs.md`.

## Layout

```
packages/providers/vercel/
  src/
    vercel-adapter.ts    # VercelAdapter — mint (long-lived), executeCall, classify, toolCapabilities
    classify.ts          # classifyVercel + vercelToolCapabilities (capability model)
    execute.ts           # JSON-RPC forward → mcp.vercel.com + REST dispatch pour custom tools
    tools.ts             # availableTools[] = upstream + custom
    upstream-tools.json  # 18 tools frozen from mcp.vercel.com (refresh manuel)
    custom-tools.ts      # 4 tools REST (update_project_settings, upsert_env_var, list_env_vars, delete_env_var)
    index.ts             # barrel
  tests/unit/adapter.test.ts
```

## Concepts du cloud — supportés / non-supportés

Vocabulaire Vercel ↔ Vaubaan. Sourcing : Context7 `/llmstxt/vercel_llms-full_txt`
(query "Vercel concepts: teams, projects, deployments, env vars, scopes,
RBAC"), 2026-05-31.

| Concept Vercel                                                                              | Supporté                                                                                           | Pourquoi                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team                                                                                        | Oui — résolu via `provider_admins.team_id` (auto-injecté en query param `teamId` par `execute.ts`) | Vercel exige `teamId` pour toutes les requêtes quand l'installation est team-scoped (cf. doc REST API "Team-Based API Requests").                                                                                                                                                                                                                          |
| Project                                                                                     | Oui — `resource_ref = prj_<...>`                                                                   | Bindings stockés en `provider_bindings`. Le classifier `classifyVercel` (`classify.ts:97`) refuse tout `args.projectId` non bindé ; auto-injecté par `mergeInjectedArgs` quand le projet a un seul binding Vercel.                                                                                                                                         |
| Deployment                                                                                  | Oui (read + trigger)                                                                               | tools `list_deployments`, `get_deployment`, `deploy_to_vercel`.                                                                                                                                                                                                                                                                                            |
| Build logs                                                                                  | Oui                                                                                                | `vercel__get_deployment_build_logs` (stream ou JSON selon paramètres).                                                                                                                                                                                                                                                                                     |
| Runtime logs                                                                                | Oui (avec filtres environment / level / source / requestId / since-until)                          | `vercel__get_runtime_logs`.                                                                                                                                                                                                                                                                                                                                |
| Env vars (project-scoped)                                                                   | Oui (list + upsert + delete)                                                                       | custom REST : `list_env_vars` (GET `/v10/projects/{id}/env`, optional `?decrypt=true`), `upsert_env_var` (POST `/v10/projects/{id}/env?upsert=true`), `delete_env_var` (DELETE `/v9/projects/{id}/env/{envId}`).                                                                                                                                           |
| Env vars (global account-wide)                                                              | Non                                                                                                | Hors-scope MVP. Le scope Vercel `global-project-env-vars` n'est pas demandé.                                                                                                                                                                                                                                                                               |
| Project settings (rootDirectory, framework, build/dev/install/output commands, nodeVersion) | Oui (read + update)                                                                                | custom REST `update_project_settings` (PATCH `/v9/projects/{id}`).                                                                                                                                                                                                                                                                                         |
| Deploy trigger                                                                              | Oui                                                                                                | `vercel__deploy_to_vercel`.                                                                                                                                                                                                                                                                                                                                |
| Domain check / pricing                                                                      | Oui (read)                                                                                         | `vercel__check_domain_availability_and_price` (jusqu'à 10 noms par appel).                                                                                                                                                                                                                                                                                 |
| Domain CRUD (add/remove/DNS records)                                                        | Non v1                                                                                             | Pas de tool exposé. Scope `domain:Read+Write` non demandé.                                                                                                                                                                                                                                                                                                 |
| Toolbar threads                                                                             | Oui (read + write — list/get/reply/edit/react/resolve)                                             | 6 tools upstream couvrant le flow toolbar comments complet.                                                                                                                                                                                                                                                                                                |
| Bypass token URL (deployment protection)                                                    | Oui (read)                                                                                         | `vercel__get_access_to_vercel_url` génère un lien temporaire qui bypass l'auth.                                                                                                                                                                                                                                                                            |
| Documentation search                                                                        | Oui                                                                                                | `vercel__search_vercel_documentation` (utile pour qu'un agent vérifie la syntaxe d'un setting).                                                                                                                                                                                                                                                            |
| Per-project tokens / per-deployment tokens                                                  | **Non** (limitation Vercel)                                                                        | Vercel ne propose pas de token scopé per-project. Les access tokens sont team-wide (Integration) ou account-wide (PAT). Le scoping projet est appliqué **côté Vaubaan** via le classifier (`classify.ts`) qui check `args.projectId ∈ bindings` + les capabilities `vercel:runtime/<level>:<action>[@<env>]`. Cf. ADR `vercel-augment-with-rest-tools.md`. |
| Team RBAC natif (Owner/Member/Developer/Viewer/Contributor + project roles)                 | Non — non utilisé                                                                                  | Vaubaan ne mappe pas vers les roles Vercel. La granularité d'accès est exprimée via nos capabilities (cf. ladder ci-dessous) + le minimum d'API Scopes côté Integration.                                                                                                                                                                                   |
| Webhooks                                                                                    | Non v1                                                                                             | Pas de tool exposé. Possible v2 si un cas d'usage métier le justifie (`deployment.succeeded` etc.).                                                                                                                                                                                                                                                        |
| Edge Config                                                                                 | Non v1                                                                                             | Pas d'usage métier identifié. Scope `edge-config` non demandé.                                                                                                                                                                                                                                                                                             |
| Log drains                                                                                  | Non v1                                                                                             | Pas de tool exposé. Scope `log-drain` non demandé.                                                                                                                                                                                                                                                                                                         |
| Project create                                                                              | Non v1                                                                                             | Pas de tool upstream à ce jour, pas de besoin métier.                                                                                                                                                                                                                                                                                                      |
| Marketplace billing / native integration                                                    | Non — hors-scope                                                                                   | Vaubaan est une **Connectable Account Integration** (registration owner-installed), pas une Marketplace listing.                                                                                                                                                                                                                                           |

## Setup opérateur (une fois)

Vaubaan est enregistré sur Vercel comme **Connectable Account Integration**.
Source de la procédure : Context7 `/llmstxt/vercel_llms-full_txt` (queries
"Create Integration scopes Redirect URL", "Exchange code for access_token",
2026-05-31) + dashboard Vercel.

### Côté Vercel (dashboard SaaS)

1. Ouvrir [https://vercel.com/dashboard](https://vercel.com/dashboard).
   Sélectionner le team owner de l'Integration dans le team switcher
   (top-left).
2. Sidebar → **Integrations** → bouton **Integrations Console** (en haut à
   droite) → **Create**. URL directe :
   [https://vercel.com/dashboard/integrations/console](https://vercel.com/dashboard/integrations/console).
3. Remplir le formulaire **Create Integration** :
   - **Name** : `Vaubaan Gateway`
   - **URL Slug** : `vaubaan-gateway` (devient `https://vercel.com/integrations/vaubaan-gateway`)
   - **Developer** / **Contact Email** / **Support Contact Email** :
     coordonnées Vaubaan
   - **Short Description**, **Overview**, **Logo** (256×256 PNG non-transparent),
     **Feature Media** (≥1 image 1440×960, ratio 3:2) — assets charte
4. Bloc **External Integration Settings** :
   - **Redirect URL** :
     - prod : `https://vaubaan.com/api/integrations/vercel/callback`
     - local : `http://localhost:3000/api/integrations/vercel/callback`
       (Vercel accepte `localhost` ; pas la contrainte HTTPS de Railway)
   - Ne pas activer la flag SSO (on est en flow OAuth standard
     `redirectLoginUrl` → `code` → `access_token`).
5. Bloc **API Scopes** — cocher uniquement les scopes listés dans la
   **Table A** de la section _Modèle de droits_ ci-dessous. Tous les autres
   scopes restent à `None`.
6. Bloc **Webhook URL** : laisser vide (non utilisé en MVP).
7. Bloc **Integrations Agreement** : accepter les termes Connectable Account
   Integration ([https://vercel.com/legal/integrations-marketplace-agreement](https://vercel.com/legal/integrations-marketplace-agreement)).
8. **Submit**. L'Integration apparaît avec le badge `Community`. Cliquer
   **View Integration** ouvre la live URL
   `https://vercel.com/integrations/vaubaan-gateway`.
9. Page **Edit Integration** → section **Credentials** : copier le
   **Client ID** et le **Client Secret**. Le Client Secret peut être rotated
   ultérieurement via le bouton **Rotate Secret**.

### Mode dégradé v0 : Paste-token (sans Integration)

Tant que le flow `authorizationUrl` / `handleCallback` reste un stub qui
throw (`vercel-adapter.ts:44-52` — _"OAuth Integration flow not
implemented yet — use paste-token mode"_), le seul moyen de connecter
Vercel est de **coller un token long-lived** directement en DB :

1. Sur le compte qui owne le team Vercel cible : ouvrir
   [https://vercel.com/account/tokens](https://vercel.com/account/tokens)
   (Account Settings → Tokens). Cliquer **Create**.
2. **Name** : `Vaubaan Gateway (paste-token)`. **Scope** : sélectionner le
   team cible (champ "Full account" ou nom du team). **Expiration** :
   laisser long ou `No expiration`. Submit.
3. Copier le token affiché une seule fois (préfixe `vcp_*`).
4. INSERT manuel dans `provider_admins` : `provider='vercel'`,
   `team_id='team_<...>'`, `access_token_encrypted=<bytea du token>`. Cf.
   structure de la table dans `supabase/migrations/0001_init.sql`.

> **Limitation paste-token v0** : pas de rotation auto, pas de UI de
> connexion guidée, pas de scoping fin (le PAT est account-wide ou
> team-wide selon le choix lors de la création). Pour la prod, prévoir la
> bascule vers l'Integration (TODO côté `vercel-adapter.ts`).

### Côté Vaubaan (env vars)

| Env var                   | Valeur (Integration)                                             | Notes                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `VERCEL_CLIENT_ID`        | Client ID copié à l'étape 9                                      | Long-lived. Non secret.                                                                                                |
| `VERCEL_CLIENT_SECRET`    | Client Secret copié à l'étape 9                                  | **Secret.** Rotation via Integrations Console.                                                                         |
| `VERCEL_INTEGRATION_SLUG` | `vaubaan-gateway`                                                | Utilisé pour construire l'install URL `https://vercel.com/integrations/<slug>/new`.                                    |
| `VERCEL_REDIRECT_URI`     | `http://localhost:3000/api/integrations/vercel/callback` (local) | Override seulement si l'origin n'est pas auto-derivable depuis `req.url`. En prod, derived from `https://vaubaan.com`. |

Mode paste-token v0 : aucune env var requise (l'INSERT manuel suffit).

### Vérification

**Integration (flow TODO) :**

1. Connecté en tant qu'org admin Vaubaan, naviguer `/orgs/<slug>/providers`.
2. Cliquer **Connect Vercel** → redirige vers
   `https://vercel.com/integrations/vaubaan-gateway/new?source=external`.
3. Sur Vercel, choisir le team cible → **Add Integration**.
4. Vercel POST le `code` au callback Vaubaan → `code` est exchanged contre
   un `access_token` (Bearer `vca_*`) via le endpoint d'exchange Vercel.
   Reference : `https://vercel.com/docs/rest-api/vercel-api-integrations#exchange-code-for-access-token`
   (code valide 30 minutes, exchanged 1 fois). Réponse contient
   `access_token` + `team_id` (null si install personal account).
5. Vaubaan stocke `(access_token, team_id, configurationId)` dans
   `provider_admins` (status=`connected`).
6. `/orgs/<slug>/providers` affiche `Vercel ✓ team <slug>`.

**Paste-token v0 :**

1. Après l'INSERT, naviguer `/orgs/<slug>/providers` → `Vercel ✓`.
2. Smoke-test : créer un binding sur un `prj_<...>` connu →
   `validateBinding` doit retourner `ok: true` avec le `displayName` du
   projet (cf. `vercel-adapter.ts:56-83`).

## Modèle de droits — provider → Vaubaan

### Table A — Scopes demandés côté Vercel Integration

Sourcing : Context7 `query-docs` "Integration Scopes Configuration" sur
`/llmstxt/vercel_llms-full_txt`, 2026-05-31. Liste complète des 12 scopes
Vercel disponibles, nous en cochons 5.

| Scope Vercel                                                                                                                | Niveau     | Pourquoi                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`                                                                                                                   | Read+Write | get/list/update project settings (custom REST `update_project_settings`). Write requis pour `update_project_settings` et pour `upsert_env_var` (env vars sont attachés à un project). |
| `project-env-vars`                                                                                                          | Read+Write | upsert et list env vars project-scoped (custom REST `upsert_env_var`).                                                                                                                |
| `deployment`                                                                                                                | Read+Write | list/get + `deploy_to_vercel` + redeploy + logs build/runtime.                                                                                                                        |
| `team`                                                                                                                      | Read       | `list_teams` + résolution du `teamId` au boot.                                                                                                                                        |
| `user`                                                                                                                      | Read       | introspection du token (validateConnection).                                                                                                                                          |
| `integration-configuration`, `global-project-env-vars`, `deployment-check`, `edge-config`, `domain`, `log-drain`, `billing` | **None**   | Non utilisés en MVP — min privilege.                                                                                                                                                  |

> **Note `domain`** : `vercel__check_domain_availability_and_price` est un
> endpoint public (registrar lookup) et ne demande pas le scope `domain`.
> Si une v2 expose `vercel__add_domain` ou `vercel__update_domain`, basculer
> `domain` en `Read+Write`.

### Table B — Surface tool → upstream → scope provider requis

22 tools exposés (18 upstream + 4 custom REST). Sourcing scopes per-tool :
Context7 `query-docs` "Vercel scopes per endpoint", 2026-05-31.

| Vaubaan tool                                      | Upstream call                                           | Scope Vercel requis                                           |
| ------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| `vercel__list_projects`                           | mcp.vercel.com / list_projects                          | `project:Read`                                                |
| `vercel__get_project`                             | mcp.vercel.com / get_project                            | `project:Read`                                                |
| `vercel__list_teams`                              | mcp.vercel.com / list_teams                             | `team:Read`                                                   |
| `vercel__list_deployments`                        | mcp.vercel.com / list_deployments                       | `deployment:Read`                                             |
| `vercel__get_deployment`                          | mcp.vercel.com / get_deployment                         | `deployment:Read`                                             |
| `vercel__get_deployment_build_logs`               | mcp.vercel.com / get_deployment_build_logs              | `deployment:Read`                                             |
| `vercel__get_runtime_logs`                        | mcp.vercel.com / get_runtime_logs                       | `deployment:Read`                                             |
| `vercel__deploy_to_vercel`                        | mcp.vercel.com / deploy_to_vercel                       | `deployment:Write`                                            |
| `vercel__check_domain_availability_and_price`     | mcp.vercel.com / check_domain_availability_and_price    | (none — registrar public)                                     |
| `vercel__get_access_to_vercel_url`                | mcp.vercel.com / get_access_to_vercel_url               | `deployment:Read`                                             |
| `vercel__web_fetch_vercel_url`                    | mcp.vercel.com / web_fetch_vercel_url                   | (none — public fetch)                                         |
| `vercel__search_vercel_documentation`             | mcp.vercel.com / search_vercel_documentation            | (none — public)                                               |
| `vercel__list_toolbar_threads`                    | mcp.vercel.com / list_toolbar_threads                   | `deployment:Read` (toolbar threads sont liés aux deployments) |
| `vercel__get_toolbar_thread`                      | mcp.vercel.com / get_toolbar_thread                     | `deployment:Read`                                             |
| `vercel__change_toolbar_thread_resolve_status`    | mcp.vercel.com / change_toolbar_thread_resolve_status   | `deployment:Write`                                            |
| `vercel__reply_to_toolbar_thread`                 | mcp.vercel.com / reply_to_toolbar_thread                | `deployment:Write`                                            |
| `vercel__edit_toolbar_message`                    | mcp.vercel.com / edit_toolbar_message                   | `deployment:Write`                                            |
| `vercel__add_toolbar_reaction`                    | mcp.vercel.com / add_toolbar_reaction                   | `deployment:Write`                                            |
| `vercel__update_project_settings` _(custom REST)_ | PATCH `api.vercel.com/v9/projects/{id}`                 | `project:Write`                                               |
| `vercel__upsert_env_var` _(custom REST)_          | POST `api.vercel.com/v10/projects/{id}/env?upsert=true` | `project-env-vars:Write`                                      |
| `vercel__list_env_vars` _(custom REST)_           | GET `api.vercel.com/v10/projects/{id}/env`              | `project-env-vars:Read`                                       |
| `vercel__delete_env_var` _(custom REST)_          | DELETE `api.vercel.com/v9/projects/{id}/env/{envId}`    | `project-env-vars:Write`                                      |

## Token mint / hot-path

`VercelAdapter.mintUpstreamToken` (`vercel-adapter.ts:54-60`) :

```ts
// 1. lit admin.access_token_encrypted (bytea, Vault-encrypted v0)
// 2. retourne { token, expiresAt: now + 365j } — placeholder, le token Vercel
//    n'expire pas par défaut côté Integration (révoqué par uninstall ou
//    rotation manuelle du secret).
// 3. executeCall() bake le teamId en query param si fourni.
```

Contrairement à Railway (refresh 1h) et GitHub (JIT JWT exchange), Vercel =
**use direct** du Bearer long-lived. Pas de cron, pas de refresh hot-path.

## Tools exposés (22)

Rewrap de 18 tools upstream `mcp.vercel.com` + 4 tools REST custom. Préfixe
`vercel__`, noms upstream en snake_case (différent de Railway en kebab-case).

- **Read list** : `vercel__list_projects`, `vercel__list_deployments`,
  `vercel__list_teams`, `vercel__list_toolbar_threads`.
- **Read get** : `vercel__get_project`, `vercel__get_deployment`,
  `vercel__get_toolbar_thread`.
- **Read logs** : `vercel__get_deployment_build_logs`,
  `vercel__get_runtime_logs`.
- **Read meta / utilities** : `vercel__search_vercel_documentation`,
  `vercel__check_domain_availability_and_price`,
  `vercel__web_fetch_vercel_url`, `vercel__get_access_to_vercel_url`.
- **Read config (custom REST)** : `vercel__list_env_vars`.
- **Write deploy** : `vercel__deploy_to_vercel`.
- **Write toolbar** : `vercel__reply_to_toolbar_thread`,
  `vercel__edit_toolbar_message`, `vercel__add_toolbar_reaction`,
  `vercel__change_toolbar_thread_resolve_status`.
- **Write project (custom REST)** : `vercel__update_project_settings`,
  `vercel__upsert_env_var`, `vercel__delete_env_var`.

`vercel__delete_env_var` est le seul tool potentiellement destructive du
wrap Vercel. Il n'est pas deny-listé : la protection passe par la policy
(`config:write@<env>` → `confirm` par défaut sur le seed), comme pour
`upsert_env_var`. Le delete project / deployment reste hors-scope.

## Capability surface

Le classifier `classifyVercel` (`classify.ts:97`) mappe chaque
`(tool, args)` en capability `vercel:runtime/<level>:<action>[@<env>]`
(cf. spec `gateway-capability-model.md` §3, §6).

Ladder du plane `runtime` (interne → externe) :

| Niveau | Slug               | Concerne                       |
| ------ | ------------------ | ------------------------------ |
| niv1   | `deployment`       | Build servi + runtime logs     |
| niv2   | `config`           | Env vars, build settings       |
| niv3   | `project-settings` | Domains, deployment protection |
| niv4   | `account`          | Project, team, tokens          |

**Env sur `deployment` / `config`** = `args.target` normalisé en
`prod` / `preview` / `development` (défaut `prod` quand absent —
conservateur, `classify.ts:envOf`).

Exemples de classification (`classify.ts:31-57`) :

| Tool                              | Capability classifiée         |
| --------------------------------- | ----------------------------- |
| `vercel__list_projects`           | `account:read`                |
| `vercel__get_project`             | `project-settings:read`       |
| `vercel__get_deployment`          | `deployment:read`             |
| `vercel__list_env_vars`           | `config:read` (env-less)      |
| `vercel__deploy_to_vercel`        | `deployment:write@<target>`   |
| `vercel__upsert_env_var`          | `config:write@<target>`       |
| `vercel__delete_env_var`          | `config:write@<target>`       |
| `vercel__update_project_settings` | `project-settings:write`      |
| `vercel__reply_to_toolbar_thread` | `deployment:write` (env-less) |

La protection des writes sensibles (deploy prod, env vars prod) est
portée par les `policy_rules` du projet ([[capability-policy-and-approvals]]),
pas par des rôles builtin. Le modèle Roles seedé en
`0002_add_builtin_roles_vercel_supabase.sql` / `0006` / `0007` a été
remplacé par les capabilities en migration `0015_capabilities_replace_roles.sql`
— tables `roles` + `access_token_roles` droppées (`0015:27-28`).

### Cheat sheet use-case → capabilities à mint

Aide l'opérateur (humain ou management key) à composer un access token
pour un coding agent au use case près. La policy par défaut force
`confirm` sur tout `write` env-less ou `@prod` ; ajuster via
`policy_rules` si l'opération doit passer en `allow` autonome.

| Use case (coding agent)                                                   | Capabilities à mint                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Audit / debug read-only (logs build + runtime, list/get deploys/projects) | `vercel:runtime/deployment:read`, `vercel:runtime/account:read`, `vercel:runtime/project-settings:read` |
| Edit project settings + env vars sur un projet bindé (no deploy)          | + `vercel:runtime/config:write@preview`, `vercel:runtime/project-settings:write`                        |
| Trigger deploy + read logs (CI-style, pas d'edit)                         | + `vercel:runtime/deployment:write@preview` (ou `@prod` avec confirm)                                   |
| Full developer (edit + deploy + read)                                     | union des 3 lignes au-dessus                                                                            |
| Diagnostic prod incident (read logs + redeploy)                           | reads + `vercel:runtime/deployment:write@prod` (déclenchera confirm)                                    |
| Répondre à toolbar threads sur previews                                   | reads + `vercel:runtime/deployment:write` (env-less, surface toolbar)                                   |

## Tests

`npx vitest run packages/providers/vercel` — `tests/unit/adapter.test.ts`
couvre : mint long-lived, validateBinding sur `prj_*`, executeCall avec
teamId injection, custom REST dispatch (`update_project_settings`,
`upsert_env_var`, `list_env_vars` GET no-body, `delete_env_var` DELETE
no-body), classify branches par kind (incl. `read-config` env-less et
`write-config-targeted` pour delete).

## Refresh procedure (rewrap)

`mcp.vercel.com` n'expose pas de webhook de changement de surface. Pour
détecter un drift entre `upstream-tools.json` et la version live :

1. Avec un Bearer Vercel valide : `POST https://mcp.vercel.com/`
   `{"jsonrpc":"2.0","method":"tools/list","id":1}` (Authorization: Bearer
   `<token>`, Accept: application/json + text/event-stream).
2. Parser le SSE frame, extraire `result.tools[]`.
3. Diff vs `packages/providers/vercel/src/upstream-tools.json`. Si nouveaux
   tools → préfixer `vercel__` et merge. Si tools supprimés → vérifier
   qu'aucun role n'en dépend (`grep -r '<tool-name>' supabase/migrations/`).
4. Si Vercel publie nativement un tool qui fait
   `update_project_settings` ou `upsert_env_var` → retirer le custom REST
   correspondant (cf. ADR `vercel-augment-with-rest-tools.md` §
   _Conditions de bascule_).

## Limitations connues / dette

- **OAuth Integration flow non implémenté** côté code (v0 = paste-token).
  Cf. `vercel-adapter.ts:44-52` (`authorizationUrl` et `handleCallback`
  throw). TODO : implémenter le flow `redirectLoginUrl` → `code` →
  exchange → upsert `provider_admins`.
- **PAT account-wide ou team-wide**. Pas de granularité project-level
  côté token Vercel. Le scoping projet vit dans le classifier Vaubaan
  via check `args.projectId ∈ bindings` (`classify.ts:108-113`).
- **Pas de webhook** Vercel intégré. Si on veut écouter `deployment.succeeded`
  pour déclencher des callbacks coding agent, v2.
- **Delete tool partiel** : seul `delete_env_var` est wrappé. Le delete
  project / deployment n'est pas exposé en MVP (à ajouter sur demande,
  avec garde-fou default-deny côté policy similaire au pattern Railway
  `accept-deploy`).

## Références

- Spec : [`docs/spec/gateway-capability-model.md`](../spec/gateway-capability-model.md) §3, §6 (capability model + classifier).
- ADRs : [[rewrap-official-mcps]], [[vercel-augment-with-rest-tools]], [[oauth-app-install-per-provider]], [[provider-onboarding-handbook-template]], [[use-context7-for-provider-docs]].
- Handbooks voisins : [[github-provider]] (pattern de référence), [[mcp-gateway]] (hot-path dispatch), [[capability-policy-and-approvals]] (policy + approval flow), [[policy-engine]] (`evaluateCapability` + scope injection).
