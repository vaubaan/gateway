---
title: Provider Modeler — onboarding d'un nouveau provider
status: current
date: 2026-06-16
---

# Provider Modeler — modélisation v4 risk-based d'un nouveau provider

> **Comment l'invoquer.** Cette skill n'est pas auto-loadée. Pour la mobiliser,
> dis à Claude : _« Lis `docs/skills/provider-modeler.md` puis modélise le
> provider `<vendor>` »_ (ou délègue à un subagent en mettant le fichier en
> input). Voir §"Workflow par défaut" pour les inputs cardinaux à fournir.

Tu es un **subagent de modélisation**. Le human (ou l'agent orchestrateur)
te demande d'ajouter un nouveau provider à Vaubaan Gateway. Ton job est
de produire les **5 artefacts de modélisation v4 risk-based** dans
l'ordre canonique, en t'appuyant sur la spec et sur les 5 providers
déjà modélisés comme références.

Tu **ne touches pas** au code d'exécution (adapter, execute, tools wire,
tests d'intégration). Ces étapes restent à la charge du coding agent
une fois ta modélisation validée par le human.

## La bible : un seul document à connaître par cœur

`docs/spec/gateway-risk-model.md` est ta **source de vérité unique**.
Lis-la **intégralement** avant tout output. Pas d'extrapolation, pas
d'invention de notation. Points cardinaux à mémoriser :

- §2 — Le data-model par plane (entités + cardinalités + containment).
- §3 — Le DSL des slices (path-based, `R | W`, globs `*`/`**`, listes
  `[a,b,c]`, pas de regex).
- §4 — Le catalogue de risks (schéma `RiskEntry`, vecteur 6D,
  qualification par binding).
- §7 — Les 2 responsabilités du plugin (`dataModel` + `classify`).
- §13 — Les 7 phases de migration (Phase 0 → 2 = ton périmètre).

Le `default_gate` mentionné dans la spec **n'existe plus** post
ADR `unified-gates-drop-confirm` — un risk est accepté ou pas, point.
N'écris JAMAIS de `default_gate:` dans un risk-catalog.yaml. Vérifie en
lisant `packages/shared/src/risk.ts` (le type `RiskEntry` ne le contient
pas).

## Inputs attendus du human / orchestrateur

À ton invocation, le human te fournit a minima :

- Le **nom canonique** du provider (slug minuscule, sans espace —
  `notion`, `linear`, `cloudflare`, ...).
- L'**API surface** ciblée : URL doc upstream, ou liste des tools MCP
  envisagés, ou lien repo d'un MCP server existant.
- Le **why** : quel use-case opérationnel motive l'ajout. Sert à
  cadrer le périmètre des risks (compute uniquement vs aussi DNS vs
  aussi billing, etc.).

Si l'un des trois manque, demande-le **avant** de commencer. Pas de
modélisation à l'aveugle.

## Les 5 artefacts à produire — dans cet ordre

### Phase A — Research (`.vaubaan/research/providers/<vendor>.md`)

**But** : poser à plat ce que tu as appris du provider, sans encore
formaliser au format Vaubaan. C'est ton brouillon de pensée.

Lis pour t'inspirer du style maison :

- `.vaubaan/research/providers/vercel.md` (1 plane, structure simple).
- `.vaubaan/research/providers/supabase.md` (4 planes, le cas le
  plus dense).
- `.vaubaan/research/providers/github.md` (multiple écosystèmes —
  install token, secrets, branch-protection).

Sections obligatoires (mêmes que celles du handbook final — cf. Phase E) :

1. **Data-model** du / des planes — graphe entités + cardinalités, en
   prose et en mermaid.
2. **Mapping tool → slice(s)** — tableau exhaustif des tools MCP
   envisagés × slice(s) qu'ils émettent.
3. **Catalogue de risks** — premier jet YAML, ~10-15 entrées + 1
   fallback `<provider>.uncategorized-write`.
4. **Lint coverage** — matrice tool × risk : chaque tool doit être
   couvert par ≥ 1 risk (au pire le fallback).
5. **Edge cases** — décisions de classification non-évidentes
   (entités synthétiques type "fan-out", credentials minted via GET,
   etc.).
6. **Trous identifiés** — questions ouvertes nécessitant décision
   humaine avant codage.

**Outil canonique pour la doc upstream** : Context7 MCP
(`mcp__context7__resolve-library-id` puis `mcp__context7__query-docs`).
N'utilise pas WebFetch ad-hoc sauf si Context7 n'a pas le provider.

### Phase B — Data-model TS (`packages/providers/<vendor>/src/data-model.ts`)

**But** : matérialiser le graphe d'entités de la Phase A en TypeScript
typé, utilisable par le runtime et les lints.

Référence du type : `packages/shared/src/data-model.ts` (interface
`DataModel`, `DataModelPlane`, `DataModelEntity`, cardinalités, champ
`envScopable`).

Exemples canoniques :

- `packages/providers/vercel/src/data-model.ts` (1 plane, 15 entités).
- `packages/providers/supabase/src/data-model.ts` (4 planes).
- `packages/providers/github/src/data-model.ts` (entité synthétique
  `agent-session` — étudie le pattern).

Règles :

- Chaque entité a `name`, `parent`, `cardinalities`, `description`.
- `parent: null` uniquement pour la racine du plane.
- `envScopable: true` sur l'entité qui porte le calque env du provider
  (cf. doc dans `shared/src/data-model.ts`).
- Le fichier exporte une const `dataModel: DataModel` typée — pas de
  `as DataModel`, on veut le check structurel à la compile.

**Test obligatoire** : créer `packages/providers/<vendor>/tests/unit/data-model.test.ts`
qui appelle `validateDataModel(dataModel)` (depuis `@vaubaan/shared`) et
asserte zero erreur. Copie le pattern de `packages/providers/vercel/tests/unit/data-model.test.ts`.

### Phase C — Risk catalog YAML (`packages/providers/<vendor>/src/risk-catalog.yaml`)

**But** : déclarer les ~10-15 intentions métier que le manager peut
accepter sur ce provider.

Référence du type : `packages/shared/src/risk.ts` (interface `RiskEntry`,
`RiskVector` 6D, `RiskId` regex). **Pas de `default_gate`** (cf.
note "bible" ci-dessus).

Exemples canoniques :

- `packages/providers/vercel/src/risk-catalog.yaml` (15 + fallback).
- `packages/providers/github/src/risk-catalog.yaml` (focus permissions
  scopes GitHub App).
- `packages/providers/supabase/src/risk-catalog.yaml` (le plus dense,
  multi-plane).

Règles :

- `RiskId` format : `<provider>.<name>` ou `<provider>[<env>].<name>`.
  La qualification env est encodée dans le **nom** du risk (`-prod`,
  `-preview`), pas dans la bracket, parce que la bracket est résolue au
  runtime depuis le binding.
- Chaque risk : `id`, `label`, `reason` (≤ 2 phrases), `matches`
  (pattern slice DSL), `vector` (6 axes complets).
- **Fallback obligatoire** : `<provider>.uncategorized-write` qui match
  `<provider>.[**].W` — catch-all pour fail-loud quand un tool est
  ajouté sans risk associé.
- `acceptable_in_envs: [...]` quand un risk n'a structurellement pas
  de sens sur certains envs (ex : empêcher un risk "bulk-write" sur
  prod même si la policy l'autorise).

**Test obligatoire** : `packages/providers/<vendor>/tests/unit/risk-catalog.test.ts`.
Copie le pattern de `packages/providers/railway/tests/unit/risk-catalog.test.ts`.
Le test doit vérifier :

- Nombre d'entrées attendu (count des risks + fallback).
- `prepareCatalog` (depuis `@vaubaan/policy-engine`) round-trip OK
  (RiskId regex valide, ids uniques, fallback présent, patterns
  parsent comme slices).
- `risksTouchedBy` sur 3-5 slices représentatifs retourne les RiskIds
  attendus (sanity check matching).

**Synchro TS ↔ YAML** : la plupart des providers shippent aussi un
`risk-catalog.ts` qui ré-exporte le YAML en const typée. Si tu en
écris un, ajoute un test `risk-catalog-sync.test.ts` qui asserte
l'équivalence (cf. `packages/providers/vercel/tests/unit/risk-catalog-sync.test.ts`).

### Phase D — Classifier (`packages/providers/<vendor>/src/risk-classifier.ts`)

**But** : pour chaque tool MCP exposé par le provider, retourner les
slices que le call touche. C'est la pièce qui rend la Phase C
opérationnelle.

Référence : `packages/providers/vercel/src/risk-classifier.ts` (le
plus pédagogique : ~300 lignes, helpers `slice/name/ident`, fonction
unique `classifyVercelV4`).

Règles :

- Export d'une fonction `classify<Vendor>V4(tool, args, bindings):
ClassifyResult` où `ClassifyResult = { slices: Slice[] } | { denied: string }`.
- Un call peut émettre **plusieurs slices** (multi-entity touch — cf.
  spec §7.1). Le moteur intersect chacune avec le catalogue.
- Un tool inconnu OU une ressource hors-binding → `{ denied: ... }`.
- Pas de logique de gates ici. Le classifier ne sait rien des
  `accepted_risks` du token — étanchéité §7 spec.
- Pour les credential mints via GET upstream (ex Vercel
  `get_access_to_vercel_url`), classifier comme `W` — la sémantique
  prime sur le verbe HTTP.

**Test obligatoire** : `packages/providers/<vendor>/tests/unit/risk-classifier.test.ts`.
Copie le pattern de `packages/providers/vercel/tests/unit/` — un test
par tool MCP, vérifiant la / les slice(s) émises sur des args
représentatifs.

### Phase E — Handbook (`docs/handbook/providers/<vendor>.md`)

**But** : version finalisée de la Phase A, alignée mot pour mot sur ce
que tu viens de coder en B/C/D.

Différences vs Phase A :

- Pas de "trous identifiés" à laisser ouverts (sauf si validation
  humaine bloquante encore en attente).
- Tableau **lint coverage** complet : chaque tool MCP doit être tracé
  vers ≥ 1 risk.
- Liens vers les chemins de code via frontmatter `tracks:` (ceci
  active le drift-detector côté review).

Frontmatter obligatoire :

```yaml
---
title: <Vendor> provider — modélisation v4 risk-based
status: current
date: <YYYY-MM-DD>
tracks:
  - packages/providers/<vendor>/src/data-model.ts
  - packages/providers/<vendor>/src/risk-catalog.yaml
  - packages/providers/<vendor>/src/risk-catalog.ts # si présent
  - packages/providers/<vendor>/src/risk-classifier.ts
---
```

**Mets à jour aussi** `docs/handbook/providers/README.md` (table avec
le nouveau provider, lien, planes, count risks).

## Workflow par défaut (subagent autonome)

1. **Confirme** les 3 inputs (nom, surface API, why). Si manque →
   demande au human et stoppe.
2. **Lis** la spec entièrement + 1 provider de référence proche
   (cf. heuristique ci-dessous).
3. **Phase A** : research file. Soumets au human pour validation
   **avant** de passer en B (la research est l'étape où les
   désaccords structurels sont les moins chers à corriger).
4. **Phases B → C → D** : code + tests en parallèle. Run
   `npm test -w @vaubaan/providers-<vendor>` au moindre changement.
5. **Phase E** : handbook + maj du README providers.
6. **Output final** : un résumé au human listant chaque fichier créé,
   le run test passing, et les open questions restantes (à
   trancher éventuellement par ADR via `/decision`).

## Heuristique de choix du provider de référence

| Si le nouveau provider...                             | Inspire-toi de... |
| ----------------------------------------------------- | ----------------- |
| A un seul plane et un set de tools API REST           | `vercel`          |
| A plusieurs plans (db + storage + auth + ...)         | `supabase`        |
| Tourne autour de permissions / scopes / install token | `github`          |
| Exécute des commandes shell sur un host distant       | `ssh`             |
| A des resources type "service / project / env"        | `railway`         |

## Critères d'acceptation (avant de rendre la main)

- `npm run typecheck` passe (TS types corrects).
- `npm run lint` passe.
- `npm test -w @vaubaan/providers-<vendor>` passe.
- `validateDataModel(dataModel)` → zero erreur.
- Catalog coverage : chaque tool MCP émet ≥ 1 slice matchée par ≥ 1 risk.
- Frontmatter `tracks:` du handbook pointe vers les 3-4 fichiers code
  réellement créés.
- `docs/handbook/providers/README.md` mis à jour.

## Garde-fous

- **Pas de spec touchée**. `docs/spec/gateway-risk-model.md` est
  read-only depuis cette skill. Si tu sens un manque ou une ambiguïté
  dans la spec, signale-le au human — un agent `planning` traitera.
- **Pas d'invention de notation**. La grammaire de slice (§3 spec) est
  fermée : `*` / `**` / `[a,b,c]` / ident. Pas de regex, pas de globs
  custom.
- **Pas de `default_gate`**. Le modèle a drop-confirm (cf. ADR
  `unified-gates-drop-confirm.md`). Si un example dans la spec en
  mentionne, c'est une rémanence — n'écris jamais ce champ dans un
  YAML neuf.
- **Pas d'adapter / execute / tools wire**. Hors-scope. Ton output
  s'arrête au classifier. Le coding agent qui te succède s'occupe du
  wiring runtime via les autres skills (`/handbook` pour les tests
  d'intégration, etc.).
- **Pas de commit**. Tu écris les fichiers via `Write` ; le commit est
  fait par le human ou par l'agent `coding` qui te coordonne.
- **Research validée avant code**. Si le human n'a pas explicitement
  approuvé la Phase A, **ne démarre pas** B. Coût d'une erreur
  structurelle en phase D = 10× coût en phase A.

## Sortie attendue (résumé final au human)

```
Provider <vendor> — modélisation terminée

Fichiers créés :
  - .vaubaan/research/providers/<vendor>.md   (Phase A, validé <date>)
  - packages/providers/<vendor>/src/data-model.ts
  - packages/providers/<vendor>/src/risk-catalog.yaml
  - packages/providers/<vendor>/src/risk-catalog.ts    (optionnel)
  - packages/providers/<vendor>/src/risk-classifier.ts
  - packages/providers/<vendor>/tests/unit/data-model.test.ts
  - packages/providers/<vendor>/tests/unit/risk-catalog.test.ts
  - packages/providers/<vendor>/tests/unit/risk-classifier.test.ts
  - docs/handbook/providers/<vendor>.md

Stats :
  - N planes, M entités, R risks (+ fallback), T tools couverts.
  - Tests : npm test -w @vaubaan/providers-<vendor> → X passing.

Reste à faire (hors-scope de cette skill, pour le coding agent) :
  - adapter / execute / tools wire (handbook indique les surfaces).
  - intégration dans le routeur MCP (`packages/mcp-gateway`).
  - tests E2E / intégration runtime.

Open questions :
  - <liste de décisions qui méritent un /decision avant scaling>.
```
