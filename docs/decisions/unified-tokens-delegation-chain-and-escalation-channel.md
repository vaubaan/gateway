---
title: Tokens unifiés avec parent_id + delegation_chain + escalation_channel hors-gateway
status: partially-superseded
date: 2026-06-16
amended: 2026-06-19
supersedes:
  - programmatic-access-token-minting
  - mint-install-token-credential
extends:
  - pivot-to-risk-based-model
partially-superseded-by: pivot-v4-to-v5-on-prem-mission-tokens
superseded-date: 2026-10-12
---

> **Partially superseded on 2026-10-12** by [[pivot-v4-to-v5-on-prem-mission-tokens]], which names the parts that survive. Legacy v4 decision; body unchanged.

# Tokens unifiés avec parent_id, delegation_chain, et escalation hors-gateway

> **ACCEPTED 2026-06-16** par Renaud. Évolution conceptuelle qui simplifie
> le modèle d'autorité : on remplace le couple (`org_management_keys` →
> `access_tokens`) par une **table unique** `tokens` avec relation
> `parent_id` récursive, et on sort **l'escalation hors du périmètre du
> gateway** (échange direct enfant → parent).

## Amendement 2026-06-19 — project-scoped roots only

> **Override** des décisions D1 et §"Wire / DB changes" ci-dessous.
> Validé par Renaud le 2026-06-19. Le reste de l'ADR est inchangé.

Trois deltas qui se motivent mutuellement :

**Δ1 — Drop `scope = 'org'`.** L'enum `scope` du schéma D1 est réduit à
la seule valeur `'project'`. Le CHECK devient :

```sql
scope text NOT NULL CHECK (scope = 'project'),
project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
```

Toute mention de "root org-scoped" / "scope='org' → org|project" dans
D1, D3 et §"UX implications" est caduque.

**Δ2 — Aucune migration depuis `org_management_keys`.** La section
"DB changes" qui prévoyait de migrer les rows existants vers
`tokens(parent_id = NULL, scope = 'org')` est **annulée**. La table
`org_management_keys` est `DROP`-ée sans data preservation. Idem pour
les rows legacy `access_tokens` : ils sont migrés vers `tokens` avec
`scope = 'project'` et `parent_id = NULL` (root). S'il n'y a pas
d'historique de minting traçable, `parent_id` reste `NULL`.

**Δ3 — Drop la notion de "carte-blanche parent".** Pas de bypass du
subset check pour aucun token. Un root token (`parent_id = NULL`)
porte une liste **explicitement énumérée** de `accepted_risks[]` —
résolue depuis le catalog au moment du mint. Pas de sentinel `'*'`,
pas de flag `is_carte_blanche`, pas de branche conditionnelle au mint.
Le helper `isCarteBlancheParent` introduit dans `packages/web/src/lib/mint/`
est supprimé.

### Justification

L'org-scope était un héritage du flow "Coding Agent Runner" (cf. ADRs
[[org-management-keys-for-runner]] → [[programmatic-access-token-minting]],
tous deux superseded par cet ADR) qui devait **auto-provisionner**
des projets côté customer. Ce cas d'usage est abandonné : chaque
projet est créé manuellement via l'UI Vaubaan et a son propre root
token project-scoped. Un root org-scoped élargit la surface d'un
leak (≈ ancien mgmt-key) sans bénéfice tangible.

La carte-blanche tombe avec la même cohérence : sans root org-scoped
à provisionner par migration, on n'a plus aucune row sans
`accepted_risks` explicite à protéger. Tous les roots passent par le
même chemin (`POST /api/v1/tokens/mint` depuis l'UI Project page,
liste de risks énumérée). Le subset check est toujours appliqué — un
parent sans accepted_risks ne peut mint aucun child, ce qui est le
comportement attendu.

### Impacts

- **D1 schema** : enum scope rétréci ; `project_id` devient `NOT NULL`.
- **D3 mint endpoint** : body schema drop le champ `scope` (toujours
  `'project'` implicitement) ; `projectId|projectSlug` devient
  obligatoire. La règle "child.scope ∈ allowed-by-parent-scope" est
  triviale (toujours `'project'`).
- **Wire changes** : `org_management_keys` → drop sans migration ;
  `vbn_mgmt_*` → drop sans dual-period.
- **UI** : `Org Settings → Management Keys` est supprimé sans
  remplacement à l'org-level. Le mint racine se fait via la
  **Project page**, onglet "Tokens". Cf. spec §10 "Bootstrap kit".
- **Forward-compat** : la colonne `scope` est gardée (CHECK tighten,
  pas DROP COLUMN) pour réversibilité en cas de besoin futur. Si on
  ré-introduit jamais un scope org-level, on relâche le CHECK.

---

## Contexte

Trois faiblesses du modèle actuel motivent ce changement.

**1. Deux types de credentials qui font la même chose.** Aujourd'hui :

- `org_management_keys` (`vbn_mgmt_*`) — autorise à mint des access tokens
- `access_tokens` (`vbn_live_*`) — autorise à appeler `/mcp` avec un set
  de `accepted_risks`

Les deux portent essentiellement les mêmes attributs (org, name, hash,
status, last_used_at) avec une distinction fonctionnelle qui peut être
exprimée par un simple champ `scope` ou par la présence d'un
`parent_id`. Le maintenir en 2 tables = duplication conceptuelle.

**2. La hiérarchie d'autorité vit en-dehors du token.** Quand un Story Dev
mint un Coding Agent, la relation "ce token a été créé par ce manager"
n'est pas tracée structurellement. L'audit forensique nécessite des
joins coûteux (et imparfaits — un mgmt key révoqué a perdu son lien
sémantique avec les access tokens qu'il a minté).

**3. L'élévation runtime n'a pas de chemin natif.** Quand un agent prend
un 403 `risk-not-accepted`, il n'y a pas de mécanisme protocolaire pour
demander à son émetteur d'élargir son scope. La spec v4 §8 mentionne
"strict-fail au MVP, Phase 2 step-up". On a besoin du step-up, mais
designé sans coupler la gateway à un orchestrateur d'IPC.

## Décision

### D1 — Une seule table `tokens`

Drop `org_management_keys`. Une seule table :

```sql
tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES tokens(id) ON DELETE CASCADE,  -- null = root
  scope text NOT NULL CHECK (scope IN ('org', 'project')),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,  -- null when scope='org'
  name text NOT NULL,
  api_key_prefix text NOT NULL,
  api_key_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  accepted_risks jsonb NOT NULL DEFAULT '[]'::jsonb,
  denied_risks jsonb NOT NULL DEFAULT '[]'::jsonb,
  depth int NOT NULL DEFAULT 0,
  delegation_chain jsonb NOT NULL DEFAULT '[]'::jsonb,
  context jsonb,
  expires_at timestamptz,
  single_use boolean NOT NULL DEFAULT false,
  consumed_at timestamptz,
  last_used_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Invariants enforced at mint by the API, not by SQL :
  --   child.accepted_risks ⊆ parent.accepted_risks
  --   child.denied_risks ⊇ parent.denied_risks  (denials propagate)
  --   child.expires_at ≤ parent.expires_at
  --   child.depth = parent.depth + 1
  --   child.scope ∈ allowed-by-parent-scope (org → org|project ; project → project)
  --   child.project_id = parent.project_id when both scope='project'
  CHECK (scope = 'project' AND project_id IS NOT NULL
      OR scope = 'org' AND project_id IS NULL),
  CHECK (depth >= 0 AND depth <= 5),  -- max-depth cap
  UNIQUE (organization_id, name)
);
```

Préfixes wire : on garde `vbn_live_*` pour tous les tokens (l'ancien
`vbn_mgmt_*` disparaît — le scope est porté par le token row, pas par
le préfixe).

### D2 — `delegation_chain` pré-calculé au mint

```ts
// Format jsonb stocké sur tokens.delegation_chain et snapshotté
// sur audit_log.delegation_chain (frozen-in-time)
delegation_chain: Array<{
  id: string; // UUID du token ancêtre
  name: string; // Display name
  depth: number; // 0 = root
  scope: 'org' | 'project';
  created_at: string; // ISO
  created_by: string | null; // user_id de l'humain ou agent_id
}>;
```

Convention d'ordre : **racine en `[0]`, parent direct en `[length-1]`**.
Root tokens (`parent_id IS NULL`) ont `delegation_chain = []`.

Au mint d'un child :

```ts
child.delegation_chain = [
  ...parent.delegation_chain,
  {
    id: parent.id,
    name: parent.name,
    depth: parent.depth,
    scope: parent.scope,
    created_at: parent.created_at,
    created_by: parent.created_by,
  },
];
```

Conséquences :

- **Pas de recursive CTE au hot-path** — 1 colonne sur le token row.
- **Audit immutable** : `audit_log.delegation_chain` est un snapshot au
  call. Un parent renommé / révoqué après le call ne mute pas le row
  audit historique.
- **Filtrage forensique trivial** : `WHERE delegation_chain @> '[{"id":"<root_id>"}]'`
  remonte toutes les actions descendant d'une racine donnée.

### D3 — Mint endpoint unique

Drop `POST /api/v1/mgmt/tokens` et la séparation préview/mgmt vs
user-auth (cf. W1 du clean-code report iter 1).

Un seul endpoint :

```
POST /api/v1/tokens/mint
  Authorization: Bearer <any vbn_live_*>
  Body: {
    name: string,
    accepted_risks: RiskId[],
    denied_risks?: RiskId[],
    scope: 'org' | 'project',
    project_id?: string,           // requis si scope='project'
    bindings?: ProjectBinding[],   // requis si scope='project'
    context?: TokenContext,
    expires_at?: string,
    single_use?: boolean,
  }
```

Le caller est identifié via son Bearer ; le row produit a `parent_id =
caller.id`. Si le caller est un root token, l'endpoint accepte. Si
c'est un token déjà à `depth=5`, il refuse (max-depth atteinte).

L'invariant subset (`child.accepted_risks ⊆ caller.accepted_risks`) est
vérifié serveur-side au mint. Si violation → 403 explicite avec liste
des risks demandés et non détenus par le caller.

### D4 — Escalation hors-gateway via `escalation_channel`

L'**élévation à l'exécution** (pas au mint) est un échange direct entre
l'enfant et son parent. La gateway n'est pas impliquée.

Au mint d'un child, le parent peut fournir dans `context` :

```ts
context: {
  task: '…',
  agent_id: '…',
  escalation_channel?: {
    transport: 'http' | 'mcp',
    endpoint_url: string,    // URL du parent : "https://orchestrator.dev/escalations"
    auth_token: string,      // secret partagé child→parent
  }
}
```

Quand l'enfant se prend un 403 `risk-not-accepted`, il consulte son
propre `context.escalation_channel` (qu'il a reçu via son token au mint)
et **poste directement** au parent :

```http
POST {endpoint_url}
Authorization: Bearer {auth_token}
Content-Type: application/json

{
  "child_token_id": "tok_abc",
  "risks_needed": ["supabase[prod].bulk-row-write"],
  "justification": "Without this call the Stripe rotation is incomplete",
  "executed_slice": "supabase.project[…].row[*].W"
}
```

Le parent gère la suite côté lui :

- **Cède** → mint un nouveau child avec scope élargi → push à son enfant.
- **Refuse** → renvoie 403 au POST.
- **Out-of-budget lui-même** → escalade à SON parent via SA propre
  `escalation_channel`. Récursion naturelle.

Pour les **roots humains**, deux options de bootstrap :

1. L'humain a un orchestrateur local (Claude Code interactif) — celui-ci
   reçoit le POST et affiche dans la session.
2. L'humain veut un bridge email/Telegram — Vaubaan offre un service
   séparé `https://vaubaan.com/escalations/<user_id>` qui forward
   HTTP→Telegram. **Ce service vit à côté du gateway**, pas dedans.

### D5 — Cascade revocation + chain integrity

`tokens.parent_id` a `ON DELETE CASCADE` : révoquer un parent kill tous
ses descendants. Mais le `delegation_chain` snapshotté dans
`audit_log` reste — la forensique post-révocation est préservée.

### D6 — `approval_requests` reste mais scope rétréci

La table `approval_requests` existante n'est **pas** drop par cet ADR.
Elle continue à servir **uniquement pour le cas mint-time** : quand un
risk demandé au mint a un `effective_gate = 'confirm'` (selon la
policy projet + le catalog), on ouvre un approval, on notifie via
`project_approval_channels` (Telegram/Email/Manual), et on attend la
décision humaine **avant** d'émettre le token.

Le runtime n'utilise plus `approval_requests`. Les escalations runtime
passent par `escalation_channel` (D4), hors-gateway.

### D7 — Tools MCP gateway inchangés

L'agent ne voit PAS de nouveau tool MCP `vaubaan__request_escalation`.
La gateway garde son périmètre minimal :

- Authentifier le Bearer
- Classifier le call → slices
- Intersect avec le catalogue → risks_touched
- Check `risks_touched ⊆ token.accepted_risks` → allow/deny
- Audit

L'escalation est un comportement **client-side** : l'agent qui se prend
un 403 lit son `context.escalation_channel` et poste lui-même. C'est
au SDK / orchestrator de l'agent de gérer le polling de la réponse,
pas à la gateway.

## Conséquences

### Wire changes (casse-tout)

- `POST /api/v1/mgmt/tokens` → **drop**, remplacé par
  `POST /api/v1/tokens/mint` (accepte n'importe quel `vbn_live_*`).
- `POST /api/v1/projects/[id]/mint` → **drop**, fusionné avec le
  unique endpoint. Ferme la duplication W1 du clean-code report.
- `vbn_mgmt_*` préfixe → **drop**. Tous les tokens portent `vbn_live_*`.
- `org_management_keys` table → **drop** (migration prévue).
  Les rows existants sont migrés vers `tokens` avec `parent_id = NULL`
  et `scope = 'org'` (root org-level).

### DB changes

- Nouvelle table `tokens` (cf. D1 schema).
- `audit_log.delegation_chain jsonb` (nullable pour les rows
  pré-migration).
- `org_management_keys` → drop (migration vide les rows actifs et
  les materialize dans `tokens` au passage).
- `access_tokens` legacy → fusionné dans `tokens` par migration data
  (chaque row → une row tokens avec depth=1, parent_id pointant vers
  le mgmt_key qui l'a minté quand traçable, sinon NULL).

### Code changes

- Mint helpers (`packages/web/src/lib/approvals/mint.ts`) → simplifiés.
  Un seul flow, pas de branchement mgmt-vs-user-auth.
- Gateway hot-path : 0 changement structurel. `loadAccessTokenContext`
  charge le `delegation_chain` en plus, c'est tout.
- UI : peut afficher la chain comme breadcrumb sur token detail page
  (forensique humaine).
- Tools MCP : aucun ajout. L'escalation est out-of-protocol.

### Audit + forensique

- Filtrage natif par racine : `WHERE delegation_chain @> '[{"id":"…"}]'`.
- Filtrage par profondeur : `WHERE depth = 3` etc.
- Chaque audit row contient le snapshot de la chain au moment du call
  — survit aux révocations / renames.

### UX implications

- **Story Dev** mint un child sans avoir besoin d'un mgmt key séparé.
  Il utilise son propre token live.
- **Coding agent** qui se prend 403 : son SDK lit
  `context.escalation_channel`, POST le parent, poll la réponse, refait
  l'appel avec le nouveau token. Tout ça côté SDK, pas gateway.
- **Humain root** : reçoit l'escalation soit dans son orchestrateur
  local soit via `vaubaan.com/escalations/<user_id>` (service séparé).

## Alternatives rejetées

### A1 — Garder mgmt_keys et access_tokens séparés

Statu quo. Maintient la duplication conceptuelle (deux tables qui
portent les mêmes attributs) et empêche la délégation récursive
("tout token peut mint un child") — un user qui veut déléguer doit
toujours avoir un mgmt key. Rejet : la simplification l'emporte.

### A2 — Gateway orchestre l'escalation (mon premier instinct)

La gateway expose un tool MCP `vaubaan__request_escalation` qui route
vers le canal pré-configuré (Telegram/Email/queue). Rejet : couple le
gateway à un concept d'IPC entre agents qui n'a rien à faire dans le
hot-path d'autorisation. Le gateway doit rester focused : authentifier,
classifier, autoriser, auditer.

### A3 — Recursive CTE au runtime pour reconstruire la chain

Pas de `delegation_chain jsonb`, on calcule récursivement à chaque
load_context. Rejet : perf (chaque mint+call ferait du recursive SQL)

- snapshot impossible (la chain changerait si un ancêtre est renommé
  post-call). Le pré-calcul + snapshot est trivial et plus correct.

### A4 — Pas de cap de profondeur

Laisse la récursion ouverte. Rejet : risque d'abus / loops accidentels
(un agent qui re-mint en boucle). `depth ≤ 5` est largement
suffisant pour les usages prévus (humain → Story Dev → Coding Agent →
sub-task agent = 4 niveaux).

### A5 — `escalation_channel` est un MCP server par convention

Au lieu d'un POST HTTP libre, le child se connecte au MCP du parent et
appelle un tool standardisé. Rejet : ajoute du protocole là où un POST
JSON suffit. Garder MCP comme transport optionnel via
`transport: 'mcp'`, mais HTTP par défaut.

### A6 — Vaubaan-centric escalation (forcer Telegram/Email)

Tous les escalations passent par Vaubaan comme broker. Rejet : pas
universel — les agents qui orchestrent eux-mêmes ne devraient pas
avoir besoin de Vaubaan comme intermediary. On laisse Vaubaan offrir
un service `inbox-to-bridge` séparé (D4 §"humain root option 2") mais
pas comme passage obligé.

## Plan de migration (séparé)

Cet ADR définit la décision. Le plan d'exécution sera détaillé dans
`.vaubaan/reports/unified-tokens-migration-plan.md` au moment d'attaquer
l'implémentation. Premières étapes attendues :

1. Migration SQL : nouvelle table `tokens`, copie atomique des rows
   `org_management_keys` + `access_tokens` existants.
2. Endpoint unique `POST /api/v1/tokens/mint`.
3. SDK / docs update pour le pattern `escalation_channel` côté agent.
4. Drop progressif des routes legacy + tables (après une période de
   dual-read).

## Notes

- Cohérent avec **OAuth 2.0 Token Exchange** (RFC 8693), **GCP IAM
  impersonation chain**, et **AWS STS AssumeRole**. On s'aligne sur
  10 ans d'industrie.
- Reste un point ouvert : **comment le parent re-push le nouveau token
  au child** après élévation accordée ? Trois options :
  (a) le child re-poll un endpoint custom du parent ;
  (b) le parent a une webhook URL côté child ;
  (c) le child se ré-authentifie en disant "j'ai été élevé, donne-moi
  mon nouveau token" — pattern OIDC token refresh.
  À trancher au moment de l'implem, probablement (a) par défaut + (c)
  pour les agents persistants.
