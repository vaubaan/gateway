---
title: Template normatif des handbooks d'onboarding provider (4 axes)
status: accepted
date: 2026-05-31
---

# Template normatif des handbooks d'onboarding provider (4 axes)

## Contexte

À date du 2026-05-31, le repo intègre 4 providers cloud (GitHub, Vercel,
Supabase, Railway). Deux handbooks existent (`github-provider.md`,
`railway-provider.md`), deux manquent (Vercel, Supabase). Les deux existants
sont solides mais **non-uniformes** — chacun a été rédigé "à l'inspiration",
avec des sections qui se ressemblent sans contrat formel.

Conséquence directe pour le user final (admin org Vaubaan, opérateur
infrastructure, ou coding agent) :

- Pas de garantie qu'un handbook couvre la décision "quels concepts du cloud
  Vaubaan supporte ou non" — risque de tester un usage non-supporté.
- Setup opérateur de qualité variable (Railway très précis, GitHub plus haut
  niveau).
- Aucun handbook ne formalise le **mapping** entre les scopes minimaux côté
  provider et nos Roles builtin. L'info est éparpillée entre les migrations
  SQL et la spec.
- Aucun handbook n'expose une **cheat sheet "use-case → Roles à attacher"**
  pour aider l'opérateur à composer un AccessToken pour un coding agent.

L'objectif du template : **scelller un format normatif** pour tous les
handbooks provider, couvrant les 4 axes demandés par le porteur produit :

- (a) Concepts du cloud supportés / non-supportés (vocabulaire **du provider**,
  décision binaire Oui/Partiel/Non + raison).
- (b) Setup opérateur step-by-step (URLs exactes, labels textuels des
  champs/boutons, valeurs à mettre — pas de screenshots, texte durable).
- (c) Modèle de droits : tableau des scopes minimaux demandés au provider +
  mapping `tool Vaubaan → upstream → scope provider requis`.
- (d) Roles builtin + cheat sheet `use-case agent → Roles à attacher`.

Le template prescrit également **comment** sourcer la doc provider : via
Context7 MCP (cf. ADR `use-context7-for-provider-docs.md`), jamais à partir de
la mémoire.

## Décision

**Template à 11 sections, ordre imposé.** Tout nouveau handbook provider
(`docs/handbook/<provider>-provider.md`) suit cet ordre. Les handbooks
existants seront alignés progressivement (hors scope de cette ADR — voir
plan d'exécution suivant).

### Front-matter (obligatoire)

Le frontmatter prescrit ci-dessous est destiné aux **handbooks générés à
partir de ce template** — pas à cette ADR elle-même (les ADRs ne déclarent
jamais de `tracks:`).

```yaml
---
title: <Provider> provider adapter
status: current
date: <YYYY-MM-DD>
tracks:
  - packages/providers/<provider>/src/
  - packages/web/src/app/api/integrations/<provider>/ # si flow OAuth web
  - supabase/migrations/<file_seeding_roles>.sql # une ligne par migration concernée
---
```

`tracks` MUST inclure : la source de l'adapter, **toutes** les migrations
qui seed des Roles du provider, et la couche web OAuth si elle existe. Le
skill `drift-detector` consomme ce frontmatter.

### Structure du corps

1. **H1 + paragraphe de pitch** — `# <Provider> provider — \`@vaubaan/providers-<provider>\``
   suivi d'une phrase rappelant le style d'adapter (rewrap/synthesis), le
   mode d'auth (App install / OAuth / paste-token), la stratégie de mint
   (long-lived / JIT / refresh), le nombre de tools exposés. Listing des
   ADRs opérantes en clôture.

2. **§ Layout** — tree de `packages/providers/<provider>/src/` (style des
   handbooks existants — bloc \`\`\` avec un commentaire de fin de ligne par
   fichier).

3. **§ Concepts du cloud — supportés / non-supportés** _(axe a)_ — tableau à
   3 colonnes :

   | Concept (vocab provider) | Supporté | Pourquoi |

   Règles :
   - 1 ligne par **concept structural** du provider (Teams, Projects,
     Environments, Deployments, Domains, Env vars, Webhooks, RBAC, Logs,
     Edge Config, Toolbar, etc.).
   - Colonne 1 = vocabulaire **du provider**, pas de jargon Vaubaan.
   - Colonne 2 = `Oui` / `Partiel` / `Non` uniquement. Jamais "WIP", jamais
     "à venir" — si c'est WIP, c'est `Non` en l'état.
   - Colonne 3 = 1-2 phrases max. Link vers l'ADR/binding/migration qui
     supporte le choix.

4. **§ Setup opérateur (une fois)** _(axe b)_ — trois sous-sections
   obligatoires :
   - **Côté provider (dashboard SaaS)** : liste numérotée. Chaque pas =
     1 URL exacte + 1 action humaine + valeurs **exactes** des champs en
     backticks. Le label de bouton/champ doit être celui retourné par
     Context7 (ou WebFetch fallback documenté), jamais inventé.
   - **Côté Vaubaan (env vars)** : tableau `env var | valeur | notes`,
     avec colonnes spécifiques local/prod si les valeurs divergent
     (cas Railway).
   - **Vérification** : une ou deux commandes/clics qui prouvent que le
     setup est correct (ex: "ouvrir `/orgs/<slug>/providers`, voir badge
     ✓ avec le team affiché").

5. **§ Modèle de droits — provider → Vaubaan** _(axe c)_ — deux tableaux
   obligatoires :
   - **Table A — Scopes demandés côté provider (les minimums)** :

     | Scope provider | Niveau (Read / Read+Write) | Pourquoi |

     Liste explicite des scopes à cocher côté provider lors de
     l'enregistrement de l'OAuth App / Integration / PAT. Niveau minimum
     possible pour l'usage Vaubaan, jamais "tous les scopes par confort".

   - **Table B — Surface tool → upstream → scope provider requis** :

     | Vaubaan tool | Upstream call | Scope provider requis |

     Permet à un auditeur de vérifier que la table A est bien le minimum :
     chaque tool exposé apparaît dans table B avec son scope, et la table A
     est l'union dédupliquée.

6. **§ Token mint / hot-path** — explique comment l'adapter sort le Bearer à
   utiliser pour un MCP call. Variantes : direct (long-lived, ex Vercel
   v0), JWT exchange (ex GitHub App install token), refresh-if-near-expiry
   (ex Railway). Cite la fonction concernée (`mintUpstreamToken` ou
   équivalent).

7. **§ Tools exposés (N)** — bucketing par verbe : `Read`, `Write`,
   `DESTRUCTIVE (deny-listé par <role>)`. Format identique aux handbooks
   existants (liste à puces, préfixés `<provider>__`). Pour les rewraps,
   noter la procédure de refresh de `upstream-tools.json` ici.

8. **§ Roles builtin** _(axe d)_ — deux composantes :
   - **Liste des Roles builtin** : 1 bullet par role (`<provider>:<name>`,
     1 ligne de description, target, glob `tool_matches` résumé, deny rules
     éventuels, migration source).
   - **Cheat sheet use-case → Roles à attacher** :

     | Use case | Roles à attacher |

     Tableau lisible par un opérateur qui crée un AccessToken via UI
     `tokens/new` ou via management key. Couvre les 4-6 cas d'usage les
     plus probables d'un coding agent (audit, edit, deploy, full-dev,
     diagnostic prod incident, etc.). Pas de presets DB (cf. design
     décision laissée out of scope cette session) — c'est un guide humain.

9. **§ Tests** — commande `npx vitest run packages/providers/<provider>` +
   nombre de tests + temps d'exécution moyen (~ms). Format des handbooks
   existants.

10. **§ Refresh procedure** _(uniquement si rewrap)_ — comment refetch
    `upstream-tools.json` (commande, conditions de bascule entre rewrap et
    custom — cf. ADR `vercel-augment-with-rest-tools.md` pour le pattern).

11. **§ Limitations connues / dette** _(optionnel)_ — bug pendants, écarts
    avec la doc provider qui n'ont pas pu être résolus, sections marquées
    `coverage_partial` dans le frontmatter quand Context7 ne couvrait pas.

### Process de sourcing (rappel de l'ADR Context7)

Avant et pendant la rédaction des sections 3 (concepts), 4 (setup), 5
(droits), l'agent DOIT appeler `resolve-library-id` puis `query-docs` sur
le provider pour chaque thématique citée. **Aucun nom de champ, URL,
scope, ou label ne doit être écrit "de mémoire"**. Si Context7 ne couvre
pas un topic, WebFetch sur URL canonique + marquage explicit dans la
section concernée (`_fallback Context7 manquant_`).

### Drift control

Le frontmatter `tracks` lie le handbook aux sources qui le sous-tendent
(adapter, migrations roles, OAuth web). Le skill `drift-detector` (déjà
existant dans `.claude/skills/`) peut comparer la date du handbook à celle
des commits modifiant les `tracks` et alerter si dérive.

## Conséquences

**Positives :**

- **Onboarding nouveau provider standardisé** : ~30-50min de rédaction
  guidée par le template au lieu de partir de zéro. Sortie garantie
  complète sur les 4 axes (a)(b)(c)(d).
- **Lecture facilitée** par un lecteur cross-provider : chercher "scopes
  provider" mène toujours à la section 5, "use cases" à la section 8.
  Aucune divination de la structure.
- **Auditabilité** des scopes : la table A peut être croisée avec les
  scopes effectivement demandés dans le code OAuth pour vérifier qu'on
  n'a pas dérivé au-delà du minimum documenté.
- **Onboarding humain démystifié** : la section 4 est rédigée pour qu'un
  opérateur qui n'a jamais touché le provider arrive au bout en <15min
  sans hallucination ni question hors-handbook.
- **Cheat sheet roles** réduit la charge cognitive de composition des
  AccessTokens — un opérateur qui doit donner accès à un agent debug
  trouve sa ligne en 5s.

**Négatives :**

- **Redondance** avec l'ADR `oauth-app-install-per-provider.md` (qui
  contient un tableau transverse provider × method × storage × mint). Accepté
  : l'ADR est la source de vérité **transverse**, le handbook est la source
  de vérité **par provider**. En cas de divergence, l'ADR gagne et le
  handbook doit être mis à jour. Le skill `drift-detector` peut catch ces
  divergences (les deux fichiers se référencent mutuellement).
- **Coût de mise à jour** : un changement de scope provider impacte le
  handbook (table A + B), la migration roles, et potentiellement l'ADR
  transverse. Trois fichiers à toucher au lieu de un. Justifié par la
  clarté pour le user final.
- **Rigidité initiale** : une section non-applicable (ex: pas de rewrap →
  pas de refresh procedure) reste optionnelle, mais le squelette doit
  être respecté. Quelques tensions à attendre sur les providers atypiques
  — résolues au cas par cas.

## Alternatives rejetées

- **Pilier doc séparé `docs/providers/<provider>/{concepts,setup,...}.md`**.
  Rejeté — sépare le "comment utiliser" du "comment installer" du "quels
  droits", brise la lecture linéaire pour un seul provider. Un fichier par
  provider reste navigable.
- **Template auto-généré depuis le code** (lecture des `tools.ts`,
  inspection des migrations roles, etc.). Rejeté MVP — le code n'a pas
  l'info "URL dashboard provider", "label exact d'un champ", "use case
  agent". À reconsidérer si on construit un meta-DSL provider plus tard.
- **Notion-as-source** (handbook vit dans Notion, exporté en MD). Rejeté
  — perte du versioning git, perte du drift-detector, perte de la
  reviewabilité PR.
- **Screenshots à la place de descriptions textuelles**. Rejeté MVP — les
  dashboards SaaS sont refresh tous les 6-12 mois, les screenshots
  rancissent vite et coûtent cher en maintenance. Texte + URL exacte +
  label de champ = plus durable. Reconsidérer si on développe un pipeline
  Playwright dédié.
- **Template + presets DB** (table `role_presets` avec bundles de roles).
  Rejeté cette session — pas mur (mots du porteur produit le 2026-05-31).
  La cheat sheet humaine dans le handbook joue le rôle de presets
  documentés sans surface technique additionnelle.
