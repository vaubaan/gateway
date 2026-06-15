---
title: env-less grant = fan-out, narrowable per-binding (github exclude)
status: partially-superseded
date: 2026-06-13
superseded-by: pivot-to-risk-based-model
superseded-date: 2026-06-15
---

# env-less grant = fan-out, narrowable per-binding (github exclude)

> **⚠️ PARTIALLY SUPERSEDED 2026-06-15** — Le concept de "grant env-less"
> disparait en v4 : chaque risk est qualifié par binding
> (`provider[env].risk-name`). L'exclude per-binding (GitHub
> `env_less_exclude_protected`) reste **techniquement** utile pour
> borner la résolution d'env au niveau du classifieur quand la slice
> émise est ambigüe. La sémantique de protection des branches
> protégées est désormais portée par les risks
> `github.merge-protected` (catalogue v4) et leur `default_gate`.
> Cf. [[gateway-risk-model]] §3 et §4.

## Contexte

Le modèle de capabilities (spec §3, §7) traitait jusqu'ici une grant env-less
comme strict-equal : `vercel:runtime/config:write` (sans `@`) ne couvrait que
les calls strict env-less, soit aucun pour les tools env-runtime (la quasi
totalité — `upsert_env_var`, `create_branch`, …). Résultat : une grant
env-less promise par le filtre statique de `tools/list` (parce que c'est la
forme énumérable hors-args) tombait systématiquement en 403 à `tools/call`.

L'UI du composer de capabilities (`RingGrid`) parlait pourtant de _"fan-out
(touches every env)"_ pour un grant env-less — promesse incohérente avec le
runtime. Symétriquement, le seul moyen de protéger `main` sur GitHub était
d'écrire des règles policy par-branche à la main pour chaque repo binté ;
fastidieux et muet pour l'opérateur qui composait son token.

## Décision

1. **`covers()` devient asymétrique** :
   - Grant `@X` couvre exactement le required `@X`.
   - Grant env-less couvre n'importe quel required `@X` (fan-out réel), modulo
     la liste `excludeEnvs` portée par le binding matché.

   Cf. `packages/shared/src/capability.ts` + tests.

2. **Knobs per-binding GitHub** (migration `0023`) :
   - `env_less_exclude_branch text` : un slug de branche à retirer du fan-out
     (le cas dominant : `main`).
   - `env_less_exclude_protected boolean` : retirer dynamiquement la liste des
     **protected branches** du repo (resolution via install token GitHub).

   XOR enforcé en DB ; github-only enforcé en DB. Le BindingForm expose les
   deux options en radio, avec defaults `branch=main`.

3. **Plumbing runtime** :
   - Le classifier GitHub renvoie la binding matchée alongside la capability ;
     le gateway en dérive `excludeEnvs` et la passe à `evaluateCapability`.
   - L'`UpstreamAdapter` expose un `resolveExcludeEnvs(admin, binding) →
Promise<string[]>` optionnel. La GitHubAdapter l'implémente : recopie le
     `env_less_exclude_branch` statique et, si `env_less_exclude_protected`
     est vrai, fait un Octokit `repos.listBranches({protected:true})` paginé
     avec un cache in-memory 60s par repo.
   - Le gateway charge `ProviderAdmin` **avant** `evaluateCapability` (au
     lieu de juste avant `executeCall`) pour que la résolution dynamique ait
     les credentials disponibles. Coût : 1 DB lookup avancé pour les calls
     déniés par la policy (rare).

## Conséquences

- L'UI dit la vérité : "aucun env coché = écrit sur TOUS les branches (fan-out)"
  reflète maintenant le runtime.
- Un opérateur peut créer un binding GitHub avec `exclude_branch='main'`,
  donner à un token la grant env-less `github:code:write`, et obtenir
  exactement le comportement attendu : push possible sur `feature/*`, 403 sur
  `main`. Sans avoir à écrire de règles policy par-branche.
- Spec §5.1 #3 & #4 retravaillées pour refléter la nouvelle sémantique.
- Les tests de `covers()` qui assertaient l'ancien strict-equal sont
  remplacés par des tests de fan-out + excludeEnvs.

## Alternatives rejetées

- **Pre-expansion des grants env-less en N grants `@<env_known>`** : nécessite
  d'énumérer les envs au mint, or les envs sont dynamiques (branches GitHub,
  targets Vercel statiques OK mais les autres non). Trop contraignant.
- **Policy rules auto-seedées à la création du binding** (`write@main → confirm`
  pour chaque binding GitHub) : couplage fort entre binding et policy, et ne
  capture pas l'intent ("ce binding ne couvre PAS main" est plus simple à dire
  qu'à dériver d'une règle).
- **Faire de `excludeEnvs` un concept de l'engine policy** (vs binding) :
  doublerait avec les règles policy qui font déjà le travail au mint.
  L'`excludeEnvs` est un _runtime knob_ (post-mint, per-call), pas une règle
  d'autorisation au mint.

## Dette restante

- Vercel / Supabase pourraient bénéficier des mêmes knobs (`@prod` à exclure
  du fan-out par-binding). Pas implémenté ici — github-first parce que c'est
  là que la demande utilisateur est apparue. Pour les ajouter, il suffira
  d'étendre la migration aux autres providers + implémenter `resolveExcludeEnvs`
  sur leur adapter (statique : pas de fetch upstream, juste recopie de
  colonnes).
- Le cache `protectedBranchesCache` est **in-memory par-instance** (Map).
  Multi-instance gateway = quelques GitHub API calls dupliqués par TTL. Si ça
  devient un problème, basculer sur `CacheClient` partagé (Redis) — l'API est
  déjà compatible.
