# Spec — RiskEntry per-env vector overrides

> **Statut** : draft (2026-06-20).
> **Auteur** : Renaud + Claude.
> **Upstream** : `docs/spec/gateway-risk-model.md` §1 (catalog pillar).
> **ADR associé** : à rédiger après validation de cette spec.

## 0. Problème

Le catalog risk porte aujourd'hui **un seul `vector: RiskVector`** par
entrée. Pour modéliser un même acte métier (ex. "deploy", "upsert env
var") dont le profil de risque varie par environnement, on duplique
l'entrée avec un suffixe `-staging` / `-prod` :

```yaml
- id: railway.deploy-staging        # acceptable_in_envs: [staging, preview, dev]
  vector: { reversibility: reversible, visibility: internal, … }

- id: railway.deploy-prod           # acceptable_in_envs: [prod]
  vector: { reversibility: costly,    visibility: public, … }
```

**Conséquences** :

1. Le `RiskId` qualifié est redondant : `railway[prod].deploy-prod`.
2. Les deux entrées partagent le même `matches` pattern → le runtime
   touchait les deux, produisant des IDs fantômes
   (`railway[prod].deploy-staging`) que le token ne peut pas contenir.
   Corrigé par le filtre `acceptable_in_envs` runtime (commit `6199ac9`),
   mais le design reste bancal.
3. "Select all" requiert de connaître le mapping env ↔ suffixe. Fragile.

## 1. Design — `vector_overrides`

On ajoute un champ optionnel `vector_overrides` à `RiskEntry` :

```typescript
export interface RiskEntry {
  readonly id: RiskId;
  // … existants inchangés …
  readonly vector: RiskVector;                              // default (envs sans override)
  readonly vector_overrides?: Record<string, Partial<RiskVector>>;  // NEW
}
```

- `vector` reste le profil par défaut (backward-compatible).
- `vector_overrides` est un dict `env-slug → axes overridés`.
  Seuls les axes qui diffèrent sont présents ; les axes absents
  héritent de `vector`.

### Résolution

```typescript
function resolveVector(entry: RiskEntry, env: string | null): RiskVector {
  if (!env || !entry.vector_overrides?.[env]) return entry.vector;
  return { ...entry.vector, ...entry.vector_overrides[env] };
}
```

### Convention de nommage

Le `RiskId` perd le suffixe d'env. Avant/après :

| Avant                              | Après                |
|------------------------------------|----------------------|
| `railway.deploy-staging`           | `railway.deploy`     |
| `railway.deploy-prod`              | `railway.deploy`     |
| `railway.upsert-variable-staging`  | `railway.upsert-variable` |
| `railway.upsert-variable-prod`     | `railway.upsert-variable` |
| `vercel.deploy-preview`            | `vercel.deploy`      |
| `vercel.deploy-prod`               | `vercel.deploy`      |
| `vercel.env-var-write-preview`     | `vercel.env-var-write` |
| `vercel.env-var-write-prod`        | `vercel.env-var-write` |
| `ssh.exec-write-staging`           | `ssh.exec-write`     |
| `ssh.exec-write-prod`              | `ssh.exec-write`     |

Le token qualifié devient `railway[prod].deploy` au lieu de
`railway[prod].deploy-prod`.

## 2. Inventaire des paires à fusionner

### Railway (2 paires, même `matches`)

| Merged ID | `acceptable_in_envs` | `vector` (default) | `vector_overrides.prod` |
|-----------|---------------------|--------------------|------------------------|
| `railway.deploy` | `[staging, preview, dev, prod]` | reversible, env, data, moderate, internal, session | `{ reversibility: costly, visibility: public }` |
| `railway.upsert-variable` | `[staging, preview, dev, prod]` | reversible, env, secret, moderate, internal, posture | `{ reversibility: costly }` |

### Vercel (2 paires, `matches` différents → array)

| Merged ID | `acceptable_in_envs` | `matches` (array) | `vector` (default) | `vector_overrides.prod` |
|-----------|---------------------|-------------------|-------------------|------------------------|
| `vercel.deploy` | `[preview, development, prod]` | `['vercel.project[**].env[preview,development].deployment.W', 'vercel.project[**].env[prod].deployment.W']` | reversible, single, data, moderate, team, session | `{ reversibility: costly, blast: env, visibility: public }` |
| `vercel.env-var-write` | `[preview, development, prod]` | `['vercel.project[**].env[preview,development].env-var[**].W', 'vercel.project[**].env[prod].env-var[**].W']` | reversible, env, secret, moderate, internal, posture | `{ reversibility: costly }` |

### SSH (1 paire, même `matches`)

| Merged ID | `acceptable_in_envs` | `vector` (default) | `vector_overrides` |
|-----------|---------------------|--------------------|--------------------|
| `ssh.exec-write` | `[staging-vps, dev-vps, prod-vps]` | costly, env, data, moderate, internal, posture | `prod-vps: { reversibility: irreversible, data: secret, cost: unbounded }` |

## 3. Impact par couche

### 3.1 `shared/src/risk.ts` — type `RiskEntry`

Ajouter `vector_overrides?: Record<string, Partial<RiskVector>>`.
Aucun champ existant ne change.

### 3.2 Catalogs YAML + TS (5 paires → 5 entrées uniques)

- Fusionner chaque paire en une seule entrée.
- `id` perd le suffixe env.
- `acceptable_in_envs` = union des deux.
- `vector` = profil non-prod (le moins risqué).
- `vector_overrides` = les axes qui changent pour prod.
- Pour Vercel : `matches` passe de string à `string[]`.

### 3.3 `policy-engine/src/risk-runtime.ts`

Aucun changement — le filtre `acceptable_in_envs` déjà en place
(commit `6199ac9`) fonctionne identiquement avec les entrées mergées.

### 3.4 Mint form UI

- `risk-row.tsx` / `vector-row.tsx` : appeler `resolveVector(entry, binding.env)`
  au lieu de lire `entry.vector` directement pour afficher le bon
  profil de risque selon le binding.
- Aucun changement structurel : une seule entrée → une seule checkbox
  par binding, qualifiée `railway[prod].deploy`.

### 3.5 Preview / mint route

Aucun changement — ces routes ne lisent pas `vector` pour la décision.

### 3.6 Tests

- Catalog sync tests (`risk-catalog.test.ts`, `risk-catalog-sync.test.ts`) :
  mettre à jour les IDs attendus.
- Classifier tests : mettre à jour les risk IDs touchés.
- Runtime tests : les tests existants couvrent déjà le filtre ; ajouter
  un test `resolveVector` dans policy-engine.

## 4. Migration tokens — breaking

Les tokens existants portant les anciens IDs (`railway.deploy-prod`,
`railway.upsert-variable-prod`, etc.) deviennent invalides. Les users
doivent re-minter. Pas de dual-read transitoire — early-stage, peu de
tokens en circulation.

## 5. Hors-scope

- Entrées avec `acceptable_in_envs` qui ne sont PAS des paires
  (ex. `supabase.bulk-row-write` restreint à `[preview, staging]`) :
  pas de fusion, pas de changement.
- Évolution des `caps` / `infra_limits` par env : même pattern possible
  mais hors-scope de cette itération.
- `railway.bulk-variables-replace` (pas de paire env) : inchangé.
- `railway.agent-action`, `railway.create-project` (account-scope) : inchangés.
