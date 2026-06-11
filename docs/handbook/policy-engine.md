---
title: Policy engine
status: current
date: 2026-06-11
tracks:
  - packages/policy-engine/src/
  - packages/policy-engine/tests/unit/
  - supabase/migrations/0016_policy_rules.sql
  - supabase/migrations/0018_gate_allow_confirm_deny.sql
---

# Policy engine — `@vaubaan/policy-engine`

Quatre modules purs autour des _capabilities_ Vaubaan (cf. spec
`docs/spec/gateway-capability-model.md` §3, §5, §7).
Le pré-migration `0015_capabilities_replace_roles.sql` (DSL Roles
nested-rules) est mort ; ce handbook documente le modèle actuel.

## Vue d'ensemble

Le paquet expose **quatre responsabilités étanches** — chacune sa
fonction pure, chacune son point d'appel :

| Module               | Concerne…                  | Appelé depuis                            |
| -------------------- | -------------------------- | ---------------------------------------- |
| `policy.ts`          | **mint-time** : gate       | `POST /api/v1/{mgmt,}/tokens`            |
| `evaluate.ts`        | **call-time** : authz      | `McpGateway.handle()` (tools/call)       |
| `tools-filter.ts`    | **discovery** : tools/list | `McpGateway.handle()` (tools/list)       |
| `scope-injection.ts` | hide/auto-fill args        | `tools/list` + `tools/call` pre-dispatch |

Aucun module n'a d'état. Aucun ne touche au DB — les routes / le
gateway les nourrissent avec des `Capability[]`, `PolicyRule[]`,
`ProviderBinding[]`. Le seul barrel est `index.ts` qui re-exporte
les 4 modules.

## Comment ça marche

### Layout

```
packages/policy-engine/
  src/
    policy.ts            # mint-time gate (allow|confirm|deny per cap)
    evaluate.ts          # call-time authz (granted ⊇ required ?)
    tools-filter.ts      # static tools/list filter (env-less surface match)
    scope-injection.ts   # owner/repo/projectId auto-injection
    index.ts             # barrel
  tests/unit/
    policy.test.ts          (12 tests)
    evaluate.test.ts        (8  tests)
    tools-filter.test.ts    (4  tests)
    scope-injection.test.ts (12 tests)
```

### `policy.ts` — mint-time gate

Consulté **au mint** (jamais sur le hot-path `/mcp`). Pour chaque
capability demandée sur le token, retourne le `gate` que le DB
`policy_rules` produit :

```ts
evaluatePolicy(
  caps: readonly Capability[],
  rules: readonly PolicyRule[],
): PolicyDecisionPerCap[]
```

`PolicyDecisionPerCap = { capability, gate: 'allow'|'confirm'|'deny', matchedRule }`.

Algorithme (`policy.ts:60-73`) — par capability :

1. Filtre les rules qui matchent (`matchesRule`, ligne 92) — wildcard
   `*` ou égalité sur chaque champ ; env-less cap ne matche que
   `env_pattern='*'`.
2. Aucune rule → `{ gate: 'deny', matchedRule: null }` (default-deny).
3. Sinon trie par `specificity desc, priority desc` (ligne 69) et
   prend le winner. La specificity (`specificity`, ligne 108) = nombre
   de champs ≠ `*` parmi `(provider, plane, level, action, env_pattern)`.

Helpers de filtrage utilisés par les routes mint :

- `allCapsAllowed(decisions)` (ligne 76) — vrai si tous les gates =
  `allow` → mint immédiat 201.
- `confirmDecisions(decisions)` (ligne 81) — sous-ensemble qui requiert
  un human-confirm → ouvre une `approval_requests` et renvoie 202.
- `denyDecisions(decisions)` (ligne 88) — sous-ensemble explicitement
  refusé → 403 final.

Schéma `policy_rules` (migration `0016_policy_rules.sql` + rename gate
en 3-states par `0018_gate_allow_confirm_deny.sql`) :

```sql
policy_rules (
  id, project_id,
  provider, plane, level,    -- exact slug or '*'
  action,                     -- 'read' | 'write' | '*'
  env_pattern,                -- exact slug or '*'
  gate,                       -- 'allow' | 'confirm' | 'deny'
  priority                    -- tie-breaker desc
)
```

Anti-pattern SQL CHECK : refuse `(action='write' ∧ env_pattern='*' ∧
gate='allow')` — un blanket allow sur les writes auto-autoriserait
prod. Cf. [`capability-policy-and-approvals.md`](./capability-policy-and-approvals.md)
pour le seed per-project + le mint flow complet.

### `evaluate.ts` — call-time authorization

Appelé sur le hot-path `/mcp` à `tools/call`, après que le plugin du
provider a classifié `(tool, args)` en `Capability` requise.

```ts
evaluateCapability(
  granted: readonly Capability[],
  required: Capability,
): PolicyDecision
```

`PolicyDecision = { decision: 'allowed' | 'denied', capabilityMatched?, reason? }`.

Pure set-membership via `isGranted` (de `@vaubaan/shared`) — exact-tuple
match. **Pas de ladder implicite, pas de wildcard sur env** : un
`@prod` requis exige un grant `@prod` (filtre défensif env). Si denied,
`reason` (`evaluate.ts:32-38`) liste les caps granted, la cap manquante,
et une suggestion de mint :

```
this access token is not granted 'github:repo/code:write@main'.
Granted capabilities: github:repo/code:write@feature/*. Mint a token
carrying 'github:repo/code:write@main' to perform this call.
```

L'agent (Claude Code, Cursor) lit ce message et corrige son appel —
c'est le _trainer not wall_ qui survit du modèle précédent.

### `tools-filter.ts` — discovery filter

Appelé sur `tools/list` pour ne lister que les tools qu'au moins
**une cap granted couvre _à env près_** :

```ts
filterAvailableTools(
  granted: readonly Capability[],
  provider: ToolSurfaceProvider,
): McpToolDeclaration[]
```

`ToolSurfaceProvider` = sous-ensemble du provider adapter (`tools-filter.ts:16`) :
`availableTools` + `toolCapabilities(toolName) → Capability[]` (la
_surface_ env-less du tool).

Logique (`tools-filter.ts:30-38`) : un tool est listé si l'une de ses
caps surface est couverte par une cap granted via
`coversIgnoringEnv` (ligne 21) — match sur `(provider, plane, level,
action)`, env ignorée. L'env dépend des args runtime et sera vérifiée
au `tools/call` par `evaluateCapability`.

### `scope-injection.ts` — hide & auto-fill args

3 fonctions qui collaborent pour cacher à l'agent les arguments
entièrement déterminés par les `provider_bindings` du projet.

Prémisse (cf. `scope-injection.ts:7-14`) : si l'access token a
exactement **1 binding** d'un provider donné, alors les args qui
identifient cette ressource (`owner+repo` pour GitHub, `projectId`
pour Vercel/Railway, `project_ref` pour Supabase, plus `teamId`
Vercel) sont déjà connus. Les exposer à l'agent est pire qu'inutile :
risque de mauvaise valeur, leak d'identifiants inutiles.

```ts
injectionPlanFor(provider, scope: ScopeContext): InjectionPlan | null
stripInjectedArgs(tool, plan): McpToolDeclaration       // tools/list
mergeInjectedArgs(args, plan): Record<string, unknown>  // tools/call
```

- `injectionPlanFor` (`:49-71`) — retourne `null` si 0 ou 2+ bindings
  pour le provider (agent doit continuer de fournir). Sinon construit
  le plan : `owner/repo` parsé de `binding.resource_ref` pour GitHub,
  `projectId` direct pour Vercel/Railway, `project_ref` pour
  Supabase. `teamId` Vercel vient de `provider_admins.team_id` via
  `ScopeContext.vercelTeamId`.
- `stripInjectedArgs` (`:78-100`) — retire les clés injectées de
  `inputSchema.properties` ET de `required[]` (sinon le tool picker
  de l'agent croit qu'elles manquent). Ne mute pas le tool d'origine.
- `mergeInjectedArgs` (`:107-119`) — auto-fill côté serveur avant
  dispatch upstream. **Caller-provided wins** : un admin peut
  override en MCP Inspector ; l'auto-fill ne s'applique que sur
  undefined / null / '' (string vide traitée comme missing).

Le mapping `provider → arg-name` est centralisé ici (single source of
truth) plutôt que dispersé dans chaque adapter.

## Comment l'utiliser

### Mint d'access token (côté route)

```ts
import { evaluatePolicy, denyDecisions, confirmDecisions, allCapsAllowed }
  from '@vaubaan/policy-engine';

const decisions = evaluatePolicy(capabilities, rules);

if (denyDecisions(decisions).length) {
  return NextResponse.json({ error: 'policy deny', denied: ... }, { status: 403 });
}
const gated = confirmDecisions(decisions);
if (gated.length) {
  // open approval flow → 202
}
// all allow → mint 201
```

Pattern réel dans `packages/web/src/app/api/v1/tokens/route.ts` et
`packages/web/src/app/api/v1/mgmt/tokens/route.ts`.

### Dispatch `/mcp` (côté gateway)

```ts
import { evaluateCapability, filterAvailableTools } from '@vaubaan/policy-engine';

// tools/list
const tools = filterAvailableTools(ctx.granted, providerAdapter);

// tools/call
const required = providerAdapter.classify(toolName, args, bindings);
const decision = evaluateCapability(ctx.granted, required.capability);
if (decision.decision === 'denied') return rpcDeny(decision.reason);
```

### Scope injection autour de `tools/list` + `tools/call`

```ts
import { injectionPlanFor, stripInjectedArgs, mergeInjectedArgs } from '@vaubaan/policy-engine';

const plan = injectionPlanFor(provider, { bindings, vercelTeamId });

// tools/list
const visible = filterAvailableTools(ctx.granted, providerAdapter).map((t) =>
  plan ? stripInjectedArgs(t, plan) : t,
);

// tools/call
const callArgs = plan ? mergeInjectedArgs(rawArgs, plan) : rawArgs;
```

## Comment debug

- **Mint renvoie 403 "policy deny" alors que la cap semble innocente**
  → no rule matche, default-deny. Inspecter `policy_rules` du projet :
  `select * from policy_rules where project_id = '...' order by specificity desc`.
  Soit ajouter une rule, soit le caller a un typo dans la notation
  (provider/plane/level mal orthographié).
- **Mint renvoie 202 sur du `read`** → seul un seed `*:*:*:read:* → allow`
  rate ; vérifier que le trigger de seed (`0016_policy_rules.sql`)
  s'est bien exécuté pour ce projet, ou qu'aucune rule plus spécifique
  `:read:` ne force `confirm`.
- **`tools/list` ne montre pas un tool attendu** → vérifier la surface :
  `providerAdapter.toolCapabilities('<tool>')`. Si la cap granted ne
  matche pas la surface à env près, `tools-filter` exclura. La cause la
  plus fréquente : grant trop spécifique sur env (env est ignoré en
  filter, mais la surface peut être env-less alors que le grant est
  `@prod` — match OK ; si la surface est `read` et le grant `write`,
  pas de match).
- **`tools/call` denied "not granted '…@prod'" alors qu'on a un
  grant `@*` sur le DB** — impossible : `evaluateCapability` exige un
  match exact via `isGranted`. Soit la cap stockée n'a pas le bon
  `env`, soit la cap requise classifiée a un env inattendu. Inspecter
  `select capabilities from access_tokens where id = '<id>'` + ajouter
  un log avant `evaluateCapability` côté gateway.
- **`tools/call` reçoit `owner=undefined`** alors qu'il y a une seule
  binding GitHub → `mergeInjectedArgs` n'a pas trouvé son plan.
  Vérifier `binding.resource_ref` matche `^[^/]+/[^/]+$` ; sinon
  `injectionPlanFor` renvoie `null` (cf. `scope-injection.ts:55-57`).

## Extension

### Ajouter un nouveau provider au plan d'injection

Étendre `injectionPlanFor` (`scope-injection.ts:49-71`) avec une
branche `if (provider === '<new>')`. Définir quelles propriétés de
`InjectionPlan` (étendre l'interface si nécessaire) sont déterminées
par la binding ; mapper depuis `resource_ref` (ou un champ
`provider_admins.*` via `ScopeContext`).

### Ajouter une rule de plus haut niveau

Le seed per-project (cf.
[`capability-policy-and-approvals.md`](./capability-policy-and-approvals.md))
pose 2 rules priority=0. Les operators ajoutent leurs overrides
plus spécifiques. **Pas de modification du moteur** — le tri par
specificity puis priority gère tout. Si une nouvelle dimension est
ajoutée à `Capability` (e.g. un 6ᵉ field), il faut étendre
`matchesRule` + `specificity` ensemble.

### Ajouter un nouvel opérateur de matching

Le moteur actuel ne supporte que `exact | *` sur chaque champ. Pour
introduire des patterns (e.g. glob sur env), modifier `matchesRule`
puis ajuster `specificity` (un pattern non-`*` reste plus spécifique
que `*` mais moins qu'un exact). Penser au CHECK SQL (`0016_policy_rules.sql`)
qui restreint actuellement la grammaire d'`env_pattern` aux slugs ou
`*` — relâcher la regex en parallèle.

## Références

- Spec : [`docs/spec/gateway-capability-model.md`](../spec/gateway-capability-model.md)
  §3 (grammaire), §5/§5.1 (policy), §7 (engine).
- Migrations : `0015_capabilities_replace_roles.sql` (drop roles),
  `0016_policy_rules.sql` (table), `0018_gate_allow_confirm_deny.sql`
  (gate enum 3-states).
- ADRs : [[policy-dsl-declarative-jsonb]] (historique — DSL Roles
  remplacé), [[mcp-only-mvp-scope]].
- Handbooks voisins : [[capability-policy-and-approvals]] (mint flow
  - approval lifecycle côté DB/UI), [[mcp-gateway]] (orchestration
    hot-path).
- Tests : `npx vitest run packages/policy-engine` — 36 tests, ~30ms.
