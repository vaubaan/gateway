---
title: Vercel provider adapter
status: current
date: 2026-06-15
tracks:
  - plugins/vercel/src/
  - apps/gateway/src/server/connections/
---

> **v4 document.** English rewrite scheduled by the v5 plan; `tracks` paths updated for the new layout.

# Vercel provider — `@vaubaan/plugin-vercel`

> **v4 risk-based catalog added — 2026-06-15.** Le pivot
> `chore(v1-drop)` a supprimé le classifier capability-based + le
> ladder `runtime/deployment/config/project-settings/account`. Le code
> expose désormais `data-model.ts` (14 entités du plane `runtime`),
> `risk-catalog.{yaml,ts}` (15 risks + fallback) et `risk-classifier.ts`
> (classifyVercelV4). Bugs latents corrigés au passage : (1)
> `upsert_env_var` honore `target: string[]` au lieu de dégrader en
> scalar, (2) `delete_env_var` émet sur les 3 envs (Vercel delete
> cross-env), (3) `get_access_to_vercel_url` classifié `bypass-token.W`
> (credential mint), (4) `list_env_vars decrypt=true` émet un
> `plaintext.R` mappé au deny-gated `read-env-var-plaintext`. Pour le
> data-model + risk catalog + tool → slice, lire le handbook v4 dédié :
> [`docs/handbook/providers/vercel.md`](./providers/vercel.md).

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
plugins/vercel/
  src/
    vercel-adapter.ts        # VercelAdapter — mint (long-lived), executeCall, classifyV4, toolSlices
    risk-classifier.ts       # classifyVercelV4 → Slice[] (cf. providers/vercel.md)
    risk-catalog.{yaml,ts}   # 15 risks + fallback (cf. providers/vercel.md)
    data-model.ts            # 14 entités du plane `runtime` (cf. providers/vercel.md)
    execute.ts               # JSON-RPC forward → mcp.vercel.com + REST dispatch pour custom tools
    tools.ts                 # availableTools[] = upstream + custom
    upstream-tools.json      # 18 tools frozen from mcp.vercel.com (refresh manuel)
    custom-tools.ts          # 4 tools REST (update_project_settings, upsert_env_var, list_env_vars, delete_env_var)
    index.ts                 # barrel
  tests/unit/
    adapter.test.ts            (23 tests)
    risk-catalog.test.ts       (58 tests)
    risk-classifier.test.ts    (32 tests)
    risk-catalog-sync.test.ts  (19 tests)
```

## Setup opérateur — Connectable Account Integration

Vaubaan est enregistré sur Vercel comme **Connectable Account Integration**.
Source de la procédure : Context7 `/llmstxt/vercel_llms-full_txt`
(2026-05-31) + dashboard Vercel.

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
4. Bloc **External Integration Settings** :
   - **Redirect URL** :
     - prod : `https://vaubaan.com/api/integrations/vercel/callback`
     - local : `http://localhost:3000/api/integrations/vercel/callback`
5. Bloc **API Scopes** — cocher uniquement : `project:Read+Write`,
   `project-env-vars:Read+Write`, `deployment:Read+Write`, `team:Read`,
   `user:Read`. Tous les autres scopes restent à `None` (min privilege).
6. Bloc **Webhook URL** : laisser vide (non utilisé en MVP).
7. **Submit**. Page **Edit Integration** → section **Credentials** :
   copier le **Client ID** et le **Client Secret**.

### Mode dégradé v0 : Paste-token (sans Integration)

Tant que le flow `authorizationUrl` / `handleCallback` reste un stub qui
throw (`vercel-adapter.ts:44-52`), connecter Vercel en collant un token
long-lived directement en DB :

1. Sur le compte qui owne le team Vercel cible : ouvrir
   [https://vercel.com/account/tokens](https://vercel.com/account/tokens),
   **Create**, **Scope** = team cible, **Expiration** = long ou
   `No expiration`. Copier le token (préfixe `vcp_*`).
2. INSERT dans `provider_admins` : `provider='vercel'`,
   `team_id='team_<...>'`, `access_token_encrypted` = résultat de
   `encryptProviderSecret(orgId, token)` encodé via `encodeByteaHexRaw()`.
   Un INSERT en clair produira du garbage au read (le decrypt AEAD échouera).
   Préférer le script `scripts/seed-test-customer.ts` qui gère ça.

### Côté Vaubaan (env vars)

| Env var                   | Valeur                                                           | Notes                                                    |
| ------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| `VERCEL_CLIENT_ID`        | Client ID copié à l'étape 7                                      | Long-lived. Non secret.                                  |
| `VERCEL_CLIENT_SECRET`    | Client Secret copié à l'étape 7                                  | **Secret.** Rotation via Integrations Console.           |
| `VERCEL_INTEGRATION_SLUG` | `vaubaan-gateway`                                                | Utilisé pour construire l'install URL.                   |
| `VERCEL_REDIRECT_URI`     | `http://localhost:3000/api/integrations/vercel/callback` (local) | Override seulement si l'origin n'est pas auto-derivable. |

Mode paste-token v0 : aucune env var requise (l'INSERT manuel suffit).

## Token mint / hot-path

`VercelAdapter.mintUpstreamToken` (`vercel-adapter.ts:54-60`) :

```ts
// 1. lit admin.access_token_encrypted (bytea, app-level libsodium AEAD)
// 2. retourne { token, expiresAt: now + 365j } — placeholder, le token Vercel
//    n'expire pas par défaut côté Integration (révoqué par uninstall ou
//    rotation manuelle du secret).
// 3. executeCall() bake le teamId en query param si fourni.
```

Contrairement à Railway (refresh 1h) et GitHub (JIT JWT exchange), Vercel =
**use direct** du Bearer long-lived. Pas de cron, pas de refresh hot-path.

## executeCall — dispatch côté provider

`execute.ts` dispatche selon `tool_name` :

- Tools upstream (préfixés `vercel__`, name upstream snake_case) →
  JSON-RPC `tools/call` forward à `mcp.vercel.com` avec le Bearer +
  `teamId` query param auto-injecté.
- Tools custom REST (`update_project_settings`, `upsert_env_var`,
  `list_env_vars`, `delete_env_var`) → appels REST directs à
  `api.vercel.com/v9`/`v10`.

22 tools exposés (18 upstream + 4 custom). La liste des tools + leurs
classifications v4 vit dans
[`docs/handbook/providers/vercel.md`](./providers/vercel.md) §Mapping
tool → slice.

## Tests

`npx vitest run plugins/vercel` — 132 tests (~80ms). Voir
[`providers/vercel.md`](./providers/vercel.md) §Tests pour le détail.

## Refresh procedure (rewrap)

`mcp.vercel.com` n'expose pas de webhook de changement de surface. Pour
détecter un drift entre `upstream-tools.json` et la version live :

1. Avec un Bearer Vercel valide : `POST https://mcp.vercel.com/`
   `{"jsonrpc":"2.0","method":"tools/list","id":1}` (Authorization: Bearer
   `<token>`, Accept: application/json + text/event-stream).
2. Parser le SSE frame, extraire `result.tools[]`.
3. Diff vs `plugins/vercel/src/upstream-tools.json`. Si nouveaux
   tools → préfixer `vercel__` et merge.
4. Si Vercel publie nativement un tool qui fait
   `update_project_settings` ou `upsert_env_var` → retirer le custom REST
   correspondant (cf. ADR `vercel-augment-with-rest-tools.md`).
5. Mettre à jour le risk catalog YAML/TS et exécuter
   `npx vitest run plugins/vercel/tests/unit/risk-catalog-sync.test.ts`.

## Limitations connues / dette

- **OAuth Integration flow non implémenté** côté code (v0 = paste-token).
  Cf. `vercel-adapter.ts:44-52`.
- **PAT account-wide ou team-wide**. Pas de granularité project-level
  côté token Vercel. Le scoping projet vit côté Vaubaan dans
  `classifyVercelV4` qui check `args.projectId ∈ bindings`.
- **Pas de webhook** Vercel intégré.
- **Delete tool partiel** : seul `delete_env_var` est wrappé.

## Références

- Handbook v4 (data-model + risk catalog + tool → slice) :
  [`docs/handbook/providers/vercel.md`](./providers/vercel.md).
- Spec : [`docs/spec/gateway-risk-model.md`](../spec/gateway-risk-model.md).
- ADRs : [[rewrap-official-mcps]], [[vercel-augment-with-rest-tools]],
  [[oauth-app-install-per-provider]], [[provider-onboarding-handbook-template]],
  [[use-context7-for-provider-docs]].
- Handbooks voisins : [[github-provider]] (pattern de référence),
  [[mcp-gateway]] (hot-path dispatch), [[escalation]] (runtime escalation_channel),
  [[policy-engine]] (`evaluateCall` + scope injection).
