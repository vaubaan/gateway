---
title: github__mint_install_token — kill host-side git credentials on session hosts
status: superseded
date: 2026-05-30
superseded-by: unified-tokens-delegation-chain-and-escalation-channel
---

# `github__mint_install_token` — kill host-side git credentials on session hosts

> **Superseded 2026-06-16.** Le tool reste exposé sous le même nom et
> la même catégorisation risque, mais le credential `vbn_mgmt_*` qui
> était requis pour l'invoquer disparaît : tout `vbn_live_*` qui
> détient le risk `github.mint-install-token` peut le déclencher. Cf.
> [[unified-tokens-delegation-chain-and-escalation-channel]] pour le
> nouveau modèle de credentials unifiés.

> **Note 2026-06-15** — Le tool reste exposé. En v4 (risk-based) il est
> catégorisé par le risk `github.mint-install-token` (vecteur
> `data: secret, persistence: posture, blast: account`), **deny par
> défaut** dans le catalogue. Un manager doit explicitement l'accepter
> pour qu'un Coding Agent puisse minter — escalation typique au humain
> via approval channel. Cf. [[gateway-risk-model]] §4.3.

## Contexte

Vaubaan exécute des sessions de coding sur des hôtes d'exécution (VPS, CI
runner, sandbox VM, laptop dev) pilotés par un client d'administration. Le
workflow actuel exige des credentials git côté hôte :

- Le bootstrap d'une session fait un `git clone` initial avant de spawn la
  sandbox → besoin d'un PAT GitHub long-vivant sur la machine.
- L'agent (`claude-code` dans la sandbox) fait `git push` → besoin du même
  type de credential dans la sandbox.

Deux problèmes :

1. **PAT long-vivants sur disque.** Une compromission du host expose toutes
   les orgs où ce PAT a accès — pas de scope per-repo, pas de rotation
   automatique.
2. **Divergence avec l'ADR `mcp-proxy-as-sole-secret-surface`.** Cette ADR
   pose que **seul** le gateway détient les credentials provider. Tout
   credential git sur un host viole le principe.

## Décision

**Le gateway expose un tool MCP `github__mint_install_token` qui mint un
GitHub App installation token court-vivant (1h) à la demande.** Le bootstrap
de session et l'agent appellent ce tool via `POST /mcp` avec leur propre
`vbn_live_*`. Plus aucun credential git ne vit sur le host.

### Mécanique

- Input : `{ repoFullName?: string, purpose: 'clone' | 'push' }`.
  - `repoFullName` optionnel — si fourni, doit être dans les bindings GitHub
    du Project ; sinon le token est scopé à TOUS les repos bindés.
  - `purpose` requis — pin par le rôle appelant via constraint policy.
- Backing App : on **réutilise** la GitHub App "Vaubaan Gateway" (App ID
  3870897). L'endpoint `POST /app/installations/{id}/access_tokens` accepte
  un body `{ repositories, permissions }` qui scope DOWN le token au
  sous-ensemble demandé — pas besoin d'une 2e App.
- Permissions sortantes mappées sur `purpose` :

  | `purpose` | Permissions GitHub                                                                 |
  | --------- | ---------------------------------------------------------------------------------- |
  | `clone`   | `contents: read`                                                                   |
  | `push`    | `contents: write` + `pull_requests: write` + `metadata: read` + `workflows: write` |

  `workflows: write` est nécessaire dès que le push touche un fichier sous
  `.github/workflows/*.yml` — GitHub rejette autrement avec « refusing to
  allow a GitHub App to create or update workflow … without `workflows`
  permission ». La permission elle-même doit aussi être accordée **au niveau
  de la GitHub App** (Permissions & events → Workflows: R/W) et acceptée
  par chaque installation existante — sinon GitHub ignore silencieusement la
  demande lors du mint.

- Output : `{ token: 'ghs_...', expires_at, repositories: [{full_name,...}], permissions }` — passé tel quel à l'appelant via le wrap MCP standard.

### Roles

Migration `0005_add_github_provisioner.sql` :

- **`github:provisioner`** (nouveau, builtin, `internal`) — single permission :
  `github__mint_install_token` avec `arguments.purpose = 'clone'`. Utilisé
  exclusivement au boot d'une session (bootstrap, clone-only). Description
  explicite « do not assign to humans ».
- **`github:developer`** (existant) — étendu pour autoriser
  `github__mint_install_token` avec `arguments.purpose IN ('clone', 'push')`.
  L'agent utilise ce rôle pour minter son token de push.

### Contrat session-host ↔ gateway

```
1. POST /api/v1/mgmt/tokens     (Bearer vbn_mgmt_*)
   { projectSlug, roleIds: [<id du rôle github:provisioner>], ... }
   → 201 { api_key: vbn_live_*, ... }

2. POST /mcp                    (Bearer vbn_live_*)
   tools/call github__mint_install_token { purpose: 'clone', repoFullName }
   → { content: [{ text: <JSON output> }] }

3. git clone https://x-access-token:$TOKEN@github.com/<repo>.git
```

## Conséquences

**Positives :**

- **Zéro credential git sur les hosts d'exécution.** Le gateway redevient
  l'unique surface de secret côté Vaubaan (cohérent avec
  `mcp-proxy-as-sole-secret-surface`).
- **Per-repo scoping.** Compromission d'un host ⇒ un seul token leaked,
  scopé à un repo, expirant en 1h. Blast radius minimal.
- **Audit complet.** Chaque mint passe par la policy engine + audit log
  (role_matched, arguments_hash). Traçabilité de qui a minté quoi quand.
- **Une seule GitHub App à maintenir.** Le scoping per-call via le body
  `permissions/repositories` évite de devoir register une App séparée.

**Négatives / coûts :**

- **Re-mint à chaque opération.** Bootstrap re-mint au boot, l'agent re-mint
  avant chaque push. Coût : 1 round-trip API GitHub (~100-300ms) + signing
  JWT côté gateway. Acceptable — pas de cache server-side (cf. hors-scope).
- \*\*L'App "Vaubaan Gateway" doit avoir `contents: write` + `pull_requests: write`
  - `metadata: read`\*\* au niveau installation. Déjà le cas (utilisé par
    `github__create_or_update_file`, `github__create_pull_request`).
- **Le rôle `github:provisioner` apparaît dans `GET /api/v1/mgmt/roles`** —
  pas filtré en v1. Description « internal — do not assign to humans » est la
  seule garde-fou. Si nécessaire, ajouter une colonne `is_internal` ultérieurement.

## Alternatives rejetées

- **Tool `git_clone` qui retourne un tarball.** Rejeté : le protocole git
  natif (https avec Basic Auth `x-access-token:<token>`) est mieux adapté
  aux cas d'usage (clone partiel, fetch incrémental, push). Retourner un
  tarball forcerait le host à abandonner git pour pousser ensuite.
- **Cache server-side des tokens dans le gateway.** Rejeté : multiplie la
  surface de leak, complique la révocation, gain négligeable (les tokens
  font 1h, GitHub n'a pas de rate-limit problématique sur ce endpoint).
- **App "Vaubaan Bootstrap" séparée de "Vaubaan Gateway".** Rejeté : zéro
  gain de sécurité (les tokens sont déjà scopés per-installation + per-request
  via `repositories`/`permissions`), coût opérateur = 2 Apps à installer
  par org cliente.
- **Rotation automatique avant expiration.** Rejeté : le consommateur
  re-mint quand il a besoin. Pas de machinerie de rotation côté gateway.

## Conditions de bascule

- **Si bootstrap + agent multiplient les mints (rate > 1Hz par session)** :
  ajouter un cache court (5-30s) dans le gateway. ADR à drafter alors.
- **Si on doit isoler les credentials de bootstrap des credentials developer**
  (ex: clients regulated) : split en 2 GitHub Apps. ADR à drafter.
