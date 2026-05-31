---
title: Vercel provider adapter
status: current
date: 2026-05-31
tracks:
  - packages/providers/vercel/src/
  - supabase/migrations/0002_add_builtin_roles_vercel_supabase.sql
  - supabase/migrations/0006_add_vercel_editor_role.sql
  - supabase/migrations/0007_add_vercel_deployer_role.sql
---

# Vercel provider — `@vaubaan/providers-vercel`

Rewrap du MCP remote officiel `mcp.vercel.com` (18 tools) augmenté de 2 tools
REST custom (`update_project_settings`, `upsert_env_var`) qui couvrent les
trous d'écriture du MCP officiel. Auth = Bearer long-lived (token
d'Integration `vca_*` ou PAT `vcp_*`), pas de refresh, scoping par `teamId`
auto-injecté côté adapter.

ADRs opérantes : `docs/decisions/rewrap-official-mcps.md`,
`docs/decisions/vercel-augment-with-rest-tools.md`,
`docs/decisions/oauth-app-install-per-provider.md`,
`docs/decisions/provider-onboarding-handbook-template.md`,
`docs/decisions/use-context7-for-provider-docs.md`.

## Layout

```
packages/providers/vercel/
  src/
    vercel-adapter.ts    # VercelAdapter — mint (long-lived), executeCall, resolveTarget
    execute.ts           # JSON-RPC forward → mcp.vercel.com + REST dispatch pour custom tools
    tools.ts             # availableTools[] = upstream + custom
    upstream-tools.json  # 18 tools frozen from mcp.vercel.com (refresh manuel)
    custom-tools.ts      # 2 tools REST (update_project_settings, upsert_env_var)
    index.ts             # barrel
  tests/unit/adapter.test.ts
```

## Concepts du cloud — supportés / non-supportés

Vocabulaire Vercel ↔ Vaubaan. Sourcing : Context7 `/llmstxt/vercel_llms-full_txt`
(query "Vercel concepts: teams, projects, deployments, env vars, scopes,
RBAC"), 2026-05-31.

| Concept Vercel                                                                              | Supporté                                                                                           | Pourquoi                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team                                                                                        | Oui — résolu via `provider_admins.team_id` (auto-injecté en query param `teamId` par `execute.ts`) | Vercel exige `teamId` pour toutes les requêtes quand l'installation est team-scoped (cf. doc REST API "Team-Based API Requests").                                                                                                                                                                 |
| Project                                                                                     | Oui — `target: 'project.vercel'`, `resource_ref = prj_<...>`                                       | Bindings stockés en `provider_bindings`. Vaubaan filtre les calls aux projects bindés via `resolveTarget`.                                                                                                                                                                                        |
| Deployment                                                                                  | Oui (read + trigger)                                                                               | tools `list_deployments`, `get_deployment`, `deploy_to_vercel`.                                                                                                                                                                                                                                   |
| Build logs                                                                                  | Oui                                                                                                | `vercel__get_deployment_build_logs` (stream ou JSON selon paramètres).                                                                                                                                                                                                                            |
| Runtime logs                                                                                | Oui (avec filtres environment / level / source / requestId / since-until)                          | `vercel__get_runtime_logs`.                                                                                                                                                                                                                                                                       |
| Env vars (project-scoped)                                                                   | Oui (read + upsert)                                                                                | upstream get via `get_project`, upsert via custom REST `upsert_env_var` (POST `/v10/projects/{id}/env?upsert=true`).                                                                                                                                                                              |
| Env vars (global account-wide)                                                              | Non                                                                                                | Hors-scope MVP. Le scope Vercel `global-project-env-vars` n'est pas demandé.                                                                                                                                                                                                                      |
| Project settings (rootDirectory, framework, build/dev/install/output commands, nodeVersion) | Oui (read + update)                                                                                | custom REST `update_project_settings` (PATCH `/v9/projects/{id}`).                                                                                                                                                                                                                                |
| Deploy trigger                                                                              | Oui                                                                                                | `vercel__deploy_to_vercel`.                                                                                                                                                                                                                                                                       |
| Domain check / pricing                                                                      | Oui (read)                                                                                         | `vercel__check_domain_availability_and_price` (jusqu'à 10 noms par appel).                                                                                                                                                                                                                        |
| Domain CRUD (add/remove/DNS records)                                                        | Non v1                                                                                             | Pas de tool exposé. Scope `domain:Read+Write` non demandé.                                                                                                                                                                                                                                        |
| Toolbar threads                                                                             | Oui (read + write — list/get/reply/edit/react/resolve)                                             | 6 tools upstream couvrant le flow toolbar comments complet.                                                                                                                                                                                                                                       |
| Bypass token URL (deployment protection)                                                    | Oui (read)                                                                                         | `vercel__get_access_to_vercel_url` génère un lien temporaire qui bypass l'auth.                                                                                                                                                                                                                   |
| Documentation search                                                                        | Oui                                                                                                | `vercel__search_vercel_documentation` (utile pour qu'un agent vérifie la syntaxe d'un setting).                                                                                                                                                                                                   |
| Per-project tokens / per-deployment tokens                                                  | **Non** (limitation Vercel)                                                                        | Vercel ne propose pas de token scopé per-project. Les access tokens sont team-wide (Integration) ou account-wide (PAT). Le scoping projet est appliqué **côté Vaubaan** via le policy DSL (`target: 'project.vercel'`) et le filtrage de `bindings`. Cf. ADR `vercel-augment-with-rest-tools.md`. |
| Team RBAC natif (Owner/Member/Developer/Viewer/Contributor + project roles)                 | Non — non utilisé                                                                                  | Vaubaan ne mappe pas vers les roles Vercel. La granularité d'accès est exprimée via nos propres Roles + le minimum d'API Scopes côté Integration.                                                                                                                                                 |
| Webhooks                                                                                    | Non v1                                                                                             | Pas de tool exposé. Possible v2 si un cas d'usage métier le justifie (`deployment.succeeded` etc.).                                                                                                                                                                                               |
| Edge Config                                                                                 | Non v1                                                                                             | Pas d'usage métier identifié. Scope `edge-config` non demandé.                                                                                                                                                                                                                                    |
| Log drains                                                                                  | Non v1                                                                                             | Pas de tool exposé. Scope `log-drain` non demandé.                                                                                                                                                                                                                                                |
| Project create                                                                              | Non v1                                                                                             | Pas de tool upstream à ce jour, pas de besoin métier.                                                                                                                                                                                                                                             |
| Marketplace billing / native integration                                                    | Non — hors-scope                                                                                   | Vaubaan est une **Connectable Account Integration** (registration owner-installed), pas une Marketplace listing.                                                                                                                                                                                  |

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

Tant que le flow `authorizationUrl` / `handleCallback` n'est pas implémenté
côté `VercelAdapter` (commentaires de `vercel-adapter.ts:38-46` : `Phase 5+`),
le seul moyen de connecter Vercel est de **coller un token long-lived**
directement en DB :

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
> bascule vers l'Integration (Phase 5+).

### Côté Vaubaan (env vars)

| Env var                   | Valeur (Integration)                                             | Notes                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `VERCEL_CLIENT_ID`        | Client ID copié à l'étape 9                                      | Long-lived. Non secret.                                                                                                |
| `VERCEL_CLIENT_SECRET`    | Client Secret copié à l'étape 9                                  | **Secret.** Rotation via Integrations Console.                                                                         |
| `VERCEL_INTEGRATION_SLUG` | `vaubaan-gateway`                                                | Utilisé pour construire l'install URL `https://vercel.com/integrations/<slug>/new`.                                    |
| `VERCEL_REDIRECT_URI`     | `http://localhost:3000/api/integrations/vercel/callback` (local) | Override seulement si l'origin n'est pas auto-derivable depuis `req.url`. En prod, derived from `https://vaubaan.com`. |

Mode paste-token v0 : aucune env var requise (l'INSERT manuel suffit).

### Vérification

**Integration (Phase 5+) :**

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

20 tools exposés (18 upstream + 2 custom REST). Sourcing scopes per-tool :
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

## Token mint / hot-path

`VercelAdapter.mintUpstreamToken` (`vercel-adapter.ts:48-54`) :

```ts
// 1. lit admin.access_token_encrypted (bytea, Vault-encrypted v0)
// 2. retourne { token, expiresAt: now + 365j } — placeholder, le token Vercel
//    n'expire pas par défaut côté Integration (révoqué par uninstall ou
//    rotation manuelle du secret).
// 3. executeCall() bake le teamId en query param si fourni.
```

Contrairement à Railway (refresh 1h) et GitHub (JIT JWT exchange), Vercel =
**use direct** du Bearer long-lived. Pas de cron, pas de refresh hot-path.

## Tools exposés (20)

Rewrap de 18 tools upstream `mcp.vercel.com` + 2 tools REST custom. Préfixe
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
- **Write deploy** : `vercel__deploy_to_vercel`.
- **Write toolbar** : `vercel__reply_to_toolbar_thread`,
  `vercel__edit_toolbar_message`, `vercel__add_toolbar_reaction`,
  `vercel__change_toolbar_thread_resolve_status`.
- **Write project (custom REST)** : `vercel__update_project_settings`,
  `vercel__upsert_env_var`.

Pas de tool **DESTRUCTIVE** deny-listé en v1 — `mcp.vercel.com` n'expose pas
de delete (le delete project, env var, deployment passe par REST direct et
n'est pas wrappé côté Vaubaan en MVP).

## Roles builtin

Seedés par migrations :

- **`vercel:viewer`** (migration `0002_add_builtin_roles_vercel_supabase.sql`) —
  read-only. `allow tool_matches: ['vercel__list_*', 'vercel__get_*',
'vercel__search_*', 'vercel__check_*', 'vercel__web_fetch_*']`,
  `target: '*'`.
- **`vercel:editor`** (migration `0006_add_vercel_editor_role.sql`) — read +
  edit project settings + env vars (pas de deploy, pas de toolbar writes).
  `allow tool_matches: ['vercel__list_*', 'vercel__get_*',
'vercel__update_*', 'vercel__upsert_*']`, `target: 'project.vercel'`.
- **`vercel:deployer`** (migration `0007_add_vercel_deployer_role.sql`,
  ajoutée 2026-05-31) — read + trigger deploy (pas d'edit, pas de toolbar
  writes). `allow tool_matches: ['vercel__list_*', 'vercel__get_*',
'vercel__deploy_to_vercel']`, `target: 'project.vercel'`.

Toolbar writes (`reply_to_toolbar_thread`, `edit_toolbar_message`,
`add_toolbar_reaction`, `change_toolbar_thread_resolve_status`) : **pas de
role builtin** en v1. Décision : attendre un signal métier réel avant
d'exposer un `vercel:commenter`. En attendant, un org admin peut créer un
role custom (org-scoped) qui autorise ces 4 tools.

### Cheat sheet use-case → Roles à attacher

Cette table aide l'opérateur (humain ou management key) à composer un
AccessToken pour un coding agent au use case près. Pas de presets DB ; un
AccessToken porte simplement N Roles (premier `allow` matched gagne, `deny`
override).

| Use case (coding agent)                                                             | Roles à attacher                                                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Audit / debug read-only (logs build + runtime, list/get deploys, list/get projects) | `vercel:viewer`                                                             |
| Edit project settings + env vars sur un projet bindé (no deploy)                    | `vercel:editor`                                                             |
| Trigger deploy + read logs (CI-style, pas d'edit)                                   | `vercel:deployer`                                                           |
| Full developer (edit + deploy + read)                                               | `vercel:editor` + `vercel:deployer`                                         |
| Diagnostic prod incident (read logs + list deploys + redeploy si besoin)            | `vercel:viewer` + `vercel:deployer`                                         |
| Repondre à toolbar threads sur previews (collab UX)                                 | `vercel:viewer` + role custom org-level pour les `vercel__*toolbar*` writes |

## Tests

`npx vitest run packages/providers/vercel` — voir `tests/unit/adapter.test.ts`
pour le détail (mint, validateBinding, executeCall avec teamId injection,
custom REST dispatch).

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
  Cf. `vercel-adapter.ts:38-46` (`authorizationUrl` et `handleCallback`
  throw). Phase 5+ : implémenter le flow `redirectLoginUrl` → `code` →
  exchange → upsert `provider_admins`.
- **PAT account-wide ou team-wide**. Pas de granularité project-level
  côté token Vercel. Le scoping projet vit dans la policy Vaubaan via
  `target: 'project.vercel'` + `bindings`.
- **Pas de webhook** Vercel intégré. Si on veut écouter `deployment.succeeded`
  pour déclencher des callbacks coding agent, v2.
- **Pas de delete tool** exposé. Le delete project / env var / deployment
  n'est pas wrappé en MVP. À ajouter sur demande, avec garde-fou deny
  similar au pattern Railway (`accept-deploy`).
