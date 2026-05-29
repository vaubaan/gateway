---
title: Policy DSL — JSON déclaratif stocké en jsonb, 7 opérateurs
status: accepted
date: 2026-05-22
tracks:
  - docs/spec/vaubaan-gateway.md
  - packages/policy-engine/src/
---

# Policy DSL — JSON déclaratif stocké en jsonb, 7 opérateurs

## Contexte

Le cœur du MCP Proxy est l'évaluation d'une **policy** contre un appel
`(tool_name, arguments)`. Plusieurs formats possibles :

1. **Code TS** : chaque Role est une fonction `(call) => Decision`
   compilée. Performance max, expressivité max.
2. **CEL / Rego / OPA** : DSL généralistes mûrs.
3. **JSON déclaratif custom** : un sous-ensemble très restreint d'opérateurs.

## Décision

**JSON déclaratif custom, stocké en `roles.permissions jsonb`.** Validation
runtime via Zod. 7 opérateurs cardinaux. Format `version: 1`.

```ts
interface Permissions {
  version: 1;
  rules: Rule[];
}
interface Rule {
  effect: 'allow' | 'deny';
  target?: 'project.repos' | 'project.vercel' | 'project.supabase' | '*';
  tool?: string;
  tool_matches?: string[]; // glob via minimatch
  constraints?: Record<string, Constraint>;
  priority?: number; // default 100, tie-break sur deny
}
type Constraint =
  | { equals: string | number | boolean }
  | { in: (string | number)[] }
  | { not_in: (string | number)[] }
  | { match: string[] } // minimatch
  | { regex: string } // RegExp
  | { starts_with: string | string[] }
  | { not_starts_with: string | string[] };
```

Sémantique d'évaluation :

1. **Default deny.** Un call non couvert par au moins une rule `allow`
   matchante est denied.
2. **Deny override allow.** Si une rule `deny` matche, elle gagne sur
   toute rule `allow` matchante. La priority sert au tie-break entre
   deux deny.
3. **Premier allow gagne** entre deux allow matchantes (l'ordre du
   `rules[]` est significatif et stable).
4. **Target résolu via bindings.** `project.repos` → `[binding.resource_ref]`
   du provider_binding du project du bot.
5. **String-coerce des valeurs.** Les operators normalisent en `String(v)`
   avant comparaison (sauf `regex` qui prend le string directement).
   `undefined` (arguments manquant) matche `false` sauf `not_in` /
   `not_starts_with` qui matchent `true`.

Le DSL est **strictement déclaratif** : pas de fonctions inline, pas
d'imports, pas de stateful checks. C'est volontaire : on doit pouvoir
afficher une Role dans l'UI en JSON brut + Markdown description, et
faire confiance à l'évaluation 100% déterministe.

Validation : un Role inséré en DB est parsé par Zod côté app à l'insertion.
Version != 1 → reject. Rule sans tool/tool_matches → reject. Constraint
avec op inconnu → reject.

## Conséquences

**Positives :**

- **Lisible.** Un Role tient en 30-50 lignes JSON. Un humain peut
  l'auditer sans tooling spécialisé. UI peut le render en pretty-JSON.
- **Stockable en jsonb.** Pas de schema rigide DB → on peut ajouter des
  opérateurs sans migration. La version (`version: 1`) gère la
  rétrocompatibilité si on doit casser plus tard.
- **Évaluation rapide.** Pas de compilation, pas d'eval. L'évaluation
  d'une rule est O(nb_constraints) — 1 µs typique. Tout le Role tient
  en <1 ms.
- **Custom roles UI (v2) faisable.** Form builder qui rend chaque Rule
  comme une carte avec dropdowns "effect / tool / constraints". Pas
  d'éditeur Monaco.
- **Property tests faciles.** Les 7 opérateurs sont testables
  exhaustivement avec des inputs string + number.

**Négatives :**

- **Pas Turing-complet.** Volontaire — mais ça veut dire que si un user
  veut "deny si `arguments.body` contient un nom de fichier qui matche
  un pattern lu dans une autre rule", il ne peut pas. Limite expressive
  acceptée : si le besoin émerge, on ajoute un opérateur ciblé
  (`contains`, `length_lt`, etc.).
- **Pas de stateful checks** (cf. spec §1.1) : "CI verte avant merge"
  exigerait un fetch upstream préalable. Hors-scope MVP.
- **Pas d'OPA / Rego.** Si plus tard l'écosystème SOC2 / supply-chain
  exige un DSL standard, switch envisageable. Le custom format n'est
  pas un investissement irrésistible.

## Alternatives rejetées

- **Code TS compilé.** Rejeté : custom roles en UI deviennent impossibles
  (l'org admin ne va pas écrire du TS), audit des roles devient illisible
  (il faut lire 20 lignes de code), risque sécurité (un bug TS dans une
  Role custom peut faire crasher le gateway).
- **OPA / Rego.** Rejeté en MVP : sur-engineering, runtime à embarquer
  (~20MB), DSL pénible à apprendre, pas justifié pour 2-3 builtin roles.
  Reconsidérable en v2+ si on tape sur des contraintes complexes
  (cross-rule, stateful).
- **CEL** (Common Expression Language Google). Rejeté en MVP : library
  TS encore jeune, similar pénibilité d'apprentissage. Reconsidérable
  si custom roles UI deviennent la norme.
- **YAML au lieu de JSON.** Rejeté : on stocke en jsonb pour les queries
  PG ; YAML imposerait une couche de sérialisation supplémentaire et
  une UX d'édition différente du runtime.
