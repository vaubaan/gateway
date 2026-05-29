---
title: Pivot v3 → v4 — du Cloud Resource Manager vers le Policy-Enforcing MCP Gateway
status: accepted
date: 2026-05-22
tracks:
  - docs/spec/vaubaan-gateway.md
---

# Pivot v3 → v4 — du Cloud Resource Manager vers le Policy-Enforcing MCP Gateway

## Contexte

Vaubaan Cloud Resource Manager **v3** distribuait des credentials cloud
(GitHub PATs, Vercel tokens, Supabase service-role keys) chiffrés
end-to-end vers le Runner client, qui les injectait dans le ~/.bashrc des
agents. L'agent recevait des secrets _en clair_ à exécution et tapait les
APIs des providers directement. Le ZK (zero-knowledge) garantissait que
Vaubaan Core ne voyait jamais les secrets en clair.

Trois constats ont fini par invalider cette ligne :

1. **Pas de filtrage sémantique possible.** Une fois le PAT chez l'agent,
   plus aucune policy ne s'applique. Un agent "developer" pouvait merger
   sur main, supprimer un repo, lire toutes les env vars Vercel — toute
   action que le scope du PAT permettait.
2. **Pas d'audit fin.** L'audit Vaubaan ne voyait que les distributions de
   creds. L'audit _côté provider_ voyait des "Vaubaan Gateway" anonymes.
   Impossible de répondre "qui a fait quoi" au niveau Vaubaan.
3. **Posture sécurité fragile.** Compromis du Runner = compromis de tous
   les creds de l'org. Compromis d'un agent = idem. Le ZK protégeait Core,
   pas le client final.

L'écosystème (Composio, Arcade.dev, Cloudflare AI Gateway) commence à
proposer des **policy-enforcing gateways** pour LLM tools. Niche peu
encombrée pour les coding agents spécifiquement.

## Décision

On rip & replace. **v4 = MCP Proxy** : un gateway JSON-RPC `/mcp` côté
Vaubaan Core qui intercepte chaque tool call d'un agent, évalue une policy
déclarative (Roles × Bots × Bindings), mint un token éphémère provider
JIT et forwarde l'appel upstream. **L'agent ne voit jamais de cred cloud.**

Cf. `docs/spec/vaubaan-gateway.md` pour la spec complète.

Pas de dual-write, pas de migration de données v3 → v4, pas de période de
coexistence. Code v3 supprimé du repo le 2026-05-22 (tag `v3-final` posé
sur le commit de wipe `d6538b7`). Possibilité de consulter v3 via
`git show v3-final:<path>` pour référence ponctuelle.

## Conséquences

**Positives :**

- Policy déclarative côté Vaubaan → filtrage **sémantique** (par tool, par
  arguments) ; deny override allow ; default deny.
- Audit immutable côté Vaubaan : 1 row par MCP call, allow ou deny.
- Compromis agent → seul son `api_key` est exposé (révocable instantanément),
  pas de cred long-lived côté provider.
- Surface produit beaucoup plus serrée : 9 tables, ~5 packages, ~15 endpoints
  REST + 1 endpoint MCP. v3 était à ~25 tables, ~12 packages.

**Négatives / coûts :**

- Trust model **non-ZK** : Vaubaan Core opère en clair les tokens upstream
  en mémoire à chaque call (cf. [[trust-model-clear-at-rest-idp-style]]).
  Le compromis Vaubaan Core compromet tous les ProviderAdmins de toutes les
  Orgs. Mitigations : Supabase Vault, audit immutable, rotation périodique
  des secrets app.
- **MCP uniquement** en MVP. Les agents qui appellent une API HTTPS
  directement (Octokit dans le code de l'agent, etc.) bypass le proxy
  (cf. [[mcp-only-mvp-scope]]).
- Aucun re-use du code v3 ; aucune réutilisation des migrations Supabase
  v3. Bootstrap from-scratch.

## Alternatives rejetées

- **Continuer v3 + ajouter une couche policy au Runner.** Rejeté : on
  pouvait inspecter les calls upstream à condition de MITM TLS le Runner.
  Le Runner est côté client (laptop dev) → MITM = installer une CA root
  custom. Friction d'install + risque de compromis CA. Le hot-path
  reste _sur le laptop_ du dev, pas auditable côté Vaubaan.
- **Mode hybride v3 + v4.** Rejeté : double complexité (deux trust models,
  deux audits, deux UX), aucun bénéfice transitoire (les users n'ont pas
  encore de prod).
- **Gateway séparé en service tiers.** Rejeté : la gestion des
  ProviderAdmins, des Roles, des Bots, et l'audit appartiennent au même
  produit. Un découpage micro-services pour 1 user → MVP overengineered.
