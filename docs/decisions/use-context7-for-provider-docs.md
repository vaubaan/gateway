---
title: Context7 MCP comme source canonique de doc des providers tiers
status: accepted
date: 2026-05-31
tracks:
  - .mcp.json
  - docs/handbook/
  - docs/decisions/provider-onboarding-handbook-template.md
---

# Context7 MCP comme source canonique de doc des providers tiers

## Contexte

Vaubaan Gateway intègre des providers cloud tiers (GitHub, Vercel, Supabase,
Railway, et d'autres à venir). Chaque intégration produit un handbook
(`docs/handbook/<provider>-provider.md`) qui décrit le setup opérateur, les
concepts cloud supportés/non-supportés, les scopes minimaux côté provider, et
le mapping vers nos Roles. Ces handbooks **citent abondamment** la doc tierce :
URLs de dashboard, noms exacts de champs, libellés de scopes, paramètres de
query string sur les callbacks OAuth.

Trois sources possibles pour cette doc :

1. **Mémoire / training cutoff du LLM** — gratuit, instant, mais **systématiquement
   stale**. La doc Vercel/Supabase/Railway évolue chaque mois (renommages,
   nouveaux scopes, ré-architecture du dashboard). Tout ce qui repose sur le
   training est une hallucination en puissance.
2. **WebFetch ad-hoc** sur les URLs canoniques pendant la rédaction. Marche,
   mais nécessite de connaître les bonnes URLs à l'avance, de paginer, et de
   parser du HTML bruité. Pas de mécanisme uniforme, pas de cache, pas de
   recherche sémantique. Risque : on rate un scope ou un champ obligatoire
   parce qu'on n'a pas fetched la bonne page.
3. **Context7 MCP** (Upstash) — service tiers qui indexe en continu les docs
   officielles de >10000 librairies/SDK/services. Expose 2 tools MCP :
   `resolve-library-id` et `query-docs`. Le LLM décrit ce qu'il cherche en
   langage naturel, Context7 retourne les snippets pertinents avec leur URL
   source. Pas de cache stale, pas de parsing HTML, pas d'URL à deviner.

Démo concrète (test 2026-05-31, voir séquencement plan) : `query-docs` sur
`/llmstxt/vercel_llms-full_txt` pour "Integration scopes" retourne la liste
exacte des 12 API Scopes Vercel (`project`, `project-env-vars`,
`global-project-env-vars`, `domain`, `log-drain`, `edge-config`, ...) avec
permission levels et descriptions. Le training cutoff aurait probablement
deviné `Projects`/`Deployments`/`Domains` — granularité plus grossière et
incomplète.

## Décision

**Context7 MCP est la source canonique de doc pour tout handbook provider du
repo.** Câblé dans `.mcp.json` à la racine du projet (committable, partagé
avec l'équipe et avec tout agent qui clone le repo).

**Process obligatoire** quand on écrit, refresh, ou audite un handbook
provider :

1. `resolve-library-id` avec le nom officiel du provider pour obtenir le
   `libraryId` Context7-compatible. Privilégier les ressources `/llmstxt/*`
   (snippet count élevé) et `/websites/*` quand l'OpenAPI seul ne suffit pas.
2. `query-docs` sur le `libraryId` choisi avec une question naturelle ciblée
   sur la section du handbook qu'on écrit (ex: "How do I create a Connectable
   Account Integration with Redirect URL and API Scopes?", "What are the
   available scopes and their permission levels?", "What is the OAuth callback
   payload?").
3. Citer dans le handbook **les noms de champs et URLs retournés par
   Context7**, jamais ceux que le LLM "se rappelle".
4. Quand un fait est cité dans le handbook (URL, scope, label), il doit avoir
   été retourné par Context7 dans la même session, ou explicitement listé
   dans la section fallback du handbook (voir ci-dessous).

**Transport HTTP**, pas stdio. Pas d'install npm requise, latence faible
(<500ms par appel), session MCP standard.

## Conséquences

**Positives :**

- **Hallucinations supprimées** sur les facts cloud (scopes, URLs, labels).
  Le handbook reflète la doc provider _à l'instant de la rédaction_ et non
  l'état figé du training cutoff.
- **Recherche sémantique** au lieu de navigation URL. On décrit le besoin en
  langage naturel, Context7 retourne les snippets pertinents même s'ils sont
  enfouis dans plusieurs sous-pages.
- **Cohérence multi-provider.** Le même process pour Vercel, Supabase,
  Railway, GitHub — pas de hack URL spécifique à chaque dashboard.
- **Tests de couverture faisables.** Avant d'intégrer un nouveau provider, on
  vérifie en 30 secondes que Context7 a une bonne couverture (snippet count
  - benchmark score) sur ce provider. Si non → fallback documenté
    explicitement, pas de surprise.
- **Re-test de fraîcheur trivial.** Pour vérifier qu'un handbook n'a pas
  dérivé, on re-query Context7 sur les mêmes topics et on diff. Le skill
  `drift-detector` peut s'en saisir en v2.

**Négatives :**

- **Dépendance externe Upstash.** Si Context7 tombe ou change son tarif, on
  doit basculer en fallback WebFetch. Accepté : la dépendance est sur la
  **doc** (un asset durable et copiable) pas sur l'exécution du gateway.
  Context7 est down ≠ Vaubaan est down.
- **Latence d'écriture handbook ↑.** Chaque section qui cite un fact
  déclenche au moins 1 appel Context7. Pour un handbook complet (~6-8
  sections), compter ~10-15 appels (~3-5 minutes ajoutées vs writing à
  partir de la mémoire). Justifié : temps gagné sur le debug d'un opérateur
  qui suit un handbook erroné > temps ajouté à la rédaction.
- **Couverture inégale par provider.** Certains providers (typiquement les
  niches ou très récents) peuvent avoir une couverture Context7 incomplète.
  Le process force à vérifier cette couverture en amont (test
  `resolve-library-id` + spot-check `query-docs`) plutôt que de découvrir le
  trou en plein milieu de l'écriture.

**Fallback documenté** : quand Context7 ne couvre pas un topic, le handbook
inclut explicitement les URLs WebFetched dans la section concernée et les
marque `_fallback Context7 manquant — vérifier à la main lors du prochain
refresh_`. Le frontmatter du handbook peut ajouter
`coverage_partial: [topic1, topic2]` pour signaler la dette.

## Alternatives rejetées

- **Mémoire / training-cutoff seul.** Rejeté — incident à attendre (un
  dashboard provider est renommé, le handbook devient faux silencieusement).
  Le mode "je me souviens" n'a aucun garde-fou.
- **WebFetch ad-hoc seul.** Rejeté MVP — pas de recherche sémantique, le LLM
  doit deviner l'URL pertinente avant de pouvoir la lire. Pour des docs
  comme Vercel qui ont des dizaines de sous-pages, le coût cognitif explose.
  Garde son intérêt en **fallback** explicit (cf. ci-dessus).
- **Scraping maison de `llms.txt`** des providers. Rejeté — Context7 le fait
  déjà, mieux, et avec recherche sémantique. Réinventer la roue.
- **Indexer la doc dans une base Vaubaan dédiée.** Rejeté MVP — overhead
  infra disproportionné pour un besoin de doc qui ne fait pas partie du
  hot-path produit. Reconsidérer si Context7 cesse d'être viable.
