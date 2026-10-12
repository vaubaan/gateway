---
title: Connect Provider via OAuth / App install — jamais de paste-token
status: partially-superseded
date: 2026-05-22
partially-superseded-by: pivot-v4-to-v5-on-prem-mission-tokens
superseded-date: 2026-10-12
---

> **Partially superseded on 2026-10-12** by [[pivot-v4-to-v5-on-prem-mission-tokens]], which names the parts that survive. Legacy v4 decision; body unchanged.

# Connect Provider via OAuth / App install — jamais de paste-token

## Contexte

Vaubaan a besoin de **credentials provider** pour mint un token éphémère à
chaque MCP call. Deux modèles d'acquisition sont possibles :

1. **Paste-token** : l'org admin va chez le Provider, génère un PAT/token,
   copie-colle dans une textarea Vaubaan. Vaubaan chiffre + stocke.
2. **OAuth / App install** : l'org admin clique "Connect <Provider>", Vaubaan
   redirige vers l'écran de consent du Provider, le Provider redirige vers
   un callback Vaubaan avec un code / installation_id, Vaubaan échange contre
   un long-lived token via API serveur-à-serveur.

V3 utilisait paste-token. On a vu ce que ça coûte : credentials orphelines
en DB, scopes incohérents, pas de provenance traçable (qui a généré le
PAT ? avec quels scopes ? quand expire-t-il ?), risque de phishing
(quelqu'un qui pousse un fake PAT).

## Décision

**OAuth / App install pour tous les providers du catalogue.** Aucune
textarea de paste-token n'apparaît dans l'UI v4.

Per-provider :

| Provider | Méthode                                            | Long-lived stocké                                    | Mint upstream                                                                                 |
| -------- | -------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| GitHub   | **GitHub App** "Vaubaan Gateway" installée per-org | `installation_id` + privkey de l'App (côté Vaubaan)  | JWT signé → `POST /app/installations/{id}/access_tokens` → installation token 1h              |
| Vercel   | **OAuth Integration** "Vaubaan Gateway"            | `access_token` long-lived + `team_id`                | use direct (long-lived)                                                                       |
| Supabase | **OAuth Mgmt API**                                 | `access_token` (1h) + `refresh_token`                | refresh dance si `expires_at - now < 5min`, sinon use direct                                  |
| Railway  | **OAuth Auth app** (authorization_code + PKCE)     | `access_token` (1h) + `refresh_token` + `expires_at` | refresh dance sur le hot-path si `expires_at - now < 60s` (cf. ADR railway-rewrap-remote-mcp) |

L'org admin **ne voit jamais de token brut**. L'écran de consent est le
Provider. La callback est Vaubaan. Le row `provider_admins` est créé par
le callback handler, avec `connected_by_user_id` = l'admin qui a cliqué.

Anti-fishing :

- Le `state` nonce du flow OAuth est stocké côté session Supabase 5min,
  single-use. Replay → reject.
- Le `returnUrl` est validé contre une allowlist hard-codée (origin Vaubaan
  Core uniquement).
- Rate-limits stricts sur `connect` et `callback` (5 req/min par user/IP).

## Conséquences

**Positives :**

- **Provenance traçable.** Chaque ProviderAdmin a un `connected_by_user_id`
  et un `connected_at`. On sait qui a connecté, quand.
- **Scopes garantis par le Provider.** L'App / OAuth Integration est
  registered avec un set de scopes fixe (Repos R/W, Pull Requests R/W,
  etc.). L'org admin ne peut pas accidentellement donner moins ou plus.
- **Révocation propre.** L'org admin peut révoquer côté Provider à tout
  moment (uninstall App). Vaubaan détecte au prochain mint upstream
  (`401 Unauthorized` → `status='revoked'` en DB).
- **Pas de stockage de PAT user-wide.** GitHub PAT classic donne accès à
  toutes les orgs du user émetteur. GitHub App scope l'accès à _cette_
  org spécifiquement.

**Négatives / coûts :**

- **Setup opérateur.** Vaubaan doit register **4 entités provider** côté
  ses dashboards admin (GitHub App, Vercel OAuth Integration, Supabase
  OAuth client, Railway Auth app). Ces objets sont **opérationnels** — gérés par
  l'opérateur Vaubaan (rpelissier en v1), pas par les org admins. ADR
  séparé serait nécessaire si on switch à des per-org GitHub Apps
  (envisagé pour clients regulated en v2+ — cf. spec §16.2).
- **Friction onboarding première fois.** L'org admin doit cliquer
  "Authorize Vaubaan Gateway to access ..." côté GitHub. Pas un drame,
  c'est exactement la même friction que connecter Vercel à un repo
  GitHub.
- **Stockage du `installation_id` GitHub** : c'est _moins sensible_ qu'un
  PAT (sans la privkey de l'App, le `installation_id` seul est inutile).
  La privkey de l'App est un secret app-level Vaubaan (Vercel env var
  `GITHUB_APP_PRIVATE_KEY`), pas un secret de la row `provider_admins`.

## Alternatives rejetées

- **Paste-token.** Rejeté : provenance opaque, scope non garanti,
  phishing-friendly, pas de révocation propre côté provider.
- **Hybrid (OAuth par défaut, paste-token fallback).** Rejeté : double UX
  à maintenir, double trust model, fallback toujours utilisé en pratique
  (les users prennent le chemin de moindre résistance). Soit on s'engage
  OAuth-only, soit pas.
- **Per-org GitHub App** (chaque Org crée _sa_ GitHub App). Rejeté en
  MVP : setup pénible pour l'org admin (registered une App custom, gérer
  les secrets), pas justifié pour le profil de client cible MVP. Pourrait
  être réintroduit en v2 pour clients regulated (banking) — ADR à drafter
  si on switch.
