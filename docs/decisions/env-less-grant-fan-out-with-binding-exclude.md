---
title: env-less grant = fan-out, narrowable per-binding (github exclude)
status: accepted
date: 2026-06-13
---

# env-less grant = fan-out, narrowable per-binding (github exclude)

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

3. **Plumbing runtime** : le classifier GitHub renvoie la binding matchée
   alongside la capability ; le gateway en dérive `excludeEnvs` et la passe à
   `evaluateCapability`.

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

- **`env_less_exclude_protected` n'est pas wired runtime** dans ce PR. Le
  champ est stocké, l'UI affiche l'option (en disabled / "preview"), mais le
  gateway l'ignore. La résolution dynamique de la liste des protected
  branches (Octokit `repos.listBranches({ protected: true })` + cache TTL)
  reste à implémenter. À ouvrir comme follow-up dédié.
- Vercel / Supabase pourraient bénéficier des mêmes knobs (`@prod` à exclure
  du fan-out par-binding). Pas implémenté ici — github-first parce que c'est
  là que la demande utilisateur est apparue.
