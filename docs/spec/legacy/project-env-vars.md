---
status: legacy
---

> **Legacy v4 document.** Kept for history; superseded by the v5 spec. Not maintained.

# Project Env Vars (venv) — spec

> **Statut :** draft (2026-06-20).
>
> La Gateway sait déjà récupérer des secrets providers (ex.
> `fetchServiceRoleKey` pour Supabase) et les consommer en interne sans
> les surfacer au LLM. **venv** généralise ce pattern : un store de
> variables d'environnement **par projet**, persisté dans le Supabase
> Core, qui permet à un tool d'**écrire** un secret et à un autre de
> le **lire** pour le pousser vers une destination — sans que la valeur
> ne transite jamais dans le contexte de conversation du LLM.
>
> Cas d'usage fondateur : transférer le `service_role` Supabase vers
> les env vars Vercel en un pipeline de deux appels MCP, sans que
> l'agent ne voie la clé.

## 0. Vocabulaire

| Terme              | Définition                                                          |
|--------------------|---------------------------------------------------------------------|
| venv               | Store de variables d'environnement par projet, persisté dans la table `project_env_vars` du Supabase Core. |
| `project_env_vars` | Table Supabase : `{ project_id, key, encrypted_value, source, created_at, updated_at }`. |
| `_to_venv`         | Suffixe de convention pour un tool qui **écrit** dans le store. Le tool retourne le nom de la clé, jamais la valeur. |
| `_from_venv`       | Suffixe de convention pour un tool qui **lit** depuis le store et pousse la valeur vers une destination externe. Le tool retourne un statut, jamais la valeur. |

## 1. Vision

1. Le LLM orchestre des transferts de secrets cross-provider sans jamais
   voir les valeurs — il manipule uniquement des **noms de clés**.
2. Chaque provider n'a besoin de connaître que venv, pas les autres
   providers. Le couplage inter-provider est nul.
3. Le store est **persisté** dans le Supabase Core (encrypted at rest
   par défaut), scopé par `project_id`. Les secrets survivent entre les
   sessions, les cold starts, et les jours.
4. Le pattern est **auto-documenté** : les suffixes `_to_venv` /
   `_from_venv` dans les noms de tools rendent le flux lisible
   pour le LLM sans explication supplémentaire.
5. Le LLM peut **lister** les clés d'un projet pour savoir ce qui est
   déjà provisionné avant de re-fetcher.

## 2. Hors-scope

- **Écriture locale** : la gateway tourne sur Vercel/Railway, elle n'a
  pas accès au filesystem du dev. Le `.env.local` reste un geste humain.
- **Lecture directe** : pas de tool `venv__read` qui retournerait la
  valeur au LLM. Le seul moyen de sortir une valeur du store est un
  tool `_from_venv` qui la pousse vers une destination.
- **Rotation automatique** : venv stocke et transfère, il ne schedule
  pas de rotation. Si un secret change chez le provider source, le
  LLM rejoue le pipeline `_to_venv` → `_from_venv`.
- **Versioning** : pas d'historique des valeurs. Un `_to_venv` sur une
  clé existante écrase la valeur précédente (upsert).

## 3. Domaine

### 3.1 Entités

```
Project (existant)
  └── ProjectEnvVar { project_id, key, encrypted_value, source, created_at, updated_at }
```

- `project_id` : FK vers `projects.id` — scope strict par projet.
- `key` : nom canonique de la variable (ex. `SUPABASE_SERVICE_ROLE_KEY`).
- `encrypted_value` : la valeur secrète. Stockée dans une colonne `text`
  — le chiffrement at rest est assuré par Supabase (TDE). Une couche
  applicative (AES-256-GCM avec une clé dérivée du projet) peut être
  ajoutée en v2.
- `source` : provenance lisible pour audit (ex. `supabase/api-keys/service_role`).

### 3.2 Table DDL

```sql
create table project_env_vars (
  project_id uuid not null references projects(id) on delete cascade,
  key        text not null,
  value      text not null,
  source     text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, key)
);

alter table project_env_vars enable row level security;

-- Aucune policy RLS : accès uniquement via service_role (gateway server-side).
-- Pas d'accès anon/authenticated.
```

### 3.3 Invariants

- **Opacité** : aucun tool MCP ne retourne jamais `value` dans sa
  réponse JSON-RPC. Seuls `key`, `source` et `status` sont surfacés.
- **Project-scoped** : un token ne peut lire/écrire que les env vars
  du projet auquel il est rattaché. Garanti par le `project_id` du
  `AccessTokenContext`.
- **Upsert** : un `_to_venv` sur une clé existante met à jour la
  valeur et le `updated_at`. Pas de write-once — les secrets changent.

## 4. Interface serveur

```typescript
interface ProjectEnvVarStore {
  /** Upsert a secret. Returns the key name (never the value). */
  put(projectId: string, key: string, value: string, source: string): Promise<void>;

  /** Read and return the value. Used internally by _from_venv tools.
   *  Throws if key not found. */
  get(projectId: string, key: string): Promise<string>;

  /** Check existence. */
  has(projectId: string, key: string): Promise<boolean>;

  /** List key names + sources + timestamps (never values). */
  list(projectId: string): Promise<Array<{ key: string; source: string; updated_at: string }>>;

  /** Delete a key. */
  delete(projectId: string, key: string): Promise<void>;
}
```

L'implémentation est un thin wrapper autour du client Supabase
service_role (déjà disponible dans le backend web) qui query
`project_env_vars`.

## 5. Tools MCP

### 5.1 Producteurs (`_to_venv`)

| Tool                                | Source                                    | Clé venv écrite                 |
|-------------------------------------|-------------------------------------------|---------------------------------|
| `supabase__service_role_to_venv`    | `GET /v1/projects/{ref}/api-keys` (PAT)   | `SUPABASE_SERVICE_ROLE_KEY`     |
| `supabase__anon_key_to_venv`        | idem, filtre `name=anon`                  | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `railway__token_to_venv`            | API Railway (token projet)                | `RAILWAY_API_TOKEN`             |

**Réponse type :**

```json
{
  "venv_key": "SUPABASE_SERVICE_ROLE_KEY",
  "source": "supabase/api-keys/service_role",
  "status": "stored"
}
```

### 5.2 Consommateurs (`_from_venv`)

| Tool                              | Destination                                  | Paramètre                       |
|-----------------------------------|----------------------------------------------|---------------------------------|
| `vercel__upsert_env_from_venv`    | `POST api.vercel.com/v10/projects/{id}/env`  | `venv_key`, `project_id`, `target[]`, `type` |
| `railway__set_variable_from_venv` | mutation `variableUpsert`                    | `venv_key`, `service_id`, `environment_id`   |
| `supabase__set_secret_from_venv`  | `POST /v1/projects/{ref}/secrets`            | `venv_key`, `project_ref`       |

**Réponse type :**

```json
{
  "venv_key": "SUPABASE_SERVICE_ROLE_KEY",
  "destination": "vercel/prj_xxx/production",
  "status": "deployed"
}
```

### 5.3 Introspection & gestion

| Tool              | Description                                                    |
|-------------------|----------------------------------------------------------------|
| `venv__list`      | Liste les clés du projet (noms + sources + dates, pas les valeurs). |
| `venv__delete`    | Supprime une clé du store.                                     |

### 5.4 Description MCP pour le LLM

Chaque tool `_to_venv` et `_from_venv` porte dans sa `description`
MCP une mention explicite :

> *"The secret value is stored/read server-side in the project's
> venv store. It is NEVER returned in the tool response — only the
> key name and status are surfaced."*

Ceci garantit que le LLM ne tente pas de demander la valeur ou de
la reconstruire.

## 6. Flux type — service_role Supabase → Vercel

```
LLM: call supabase__service_role_to_venv({ project_ref: "abc123" })
GW:  fetch GET /v1/projects/abc123/api-keys → extract service_role
     store.put(projectId, "SUPABASE_SERVICE_ROLE_KEY", "eyJ...", "supabase/api-keys/service_role")
     → { venv_key: "SUPABASE_SERVICE_ROLE_KEY", source: "supabase/api-keys/service_role", status: "stored" }

LLM: call vercel__upsert_env_from_venv({
       venv_key: "SUPABASE_SERVICE_ROLE_KEY",
       vercel_project_id: "prj_xxx",
       target: ["production"],
       type: "encrypted"
     })
GW:  val = store.get(projectId, "SUPABASE_SERVICE_ROLE_KEY")
     POST api.vercel.com/v10/projects/prj_xxx/env
       { key: "SUPABASE_SERVICE_ROLE_KEY", value: val, target: ["production"], type: "encrypted" }
     → { venv_key: "SUPABASE_SERVICE_ROLE_KEY", destination: "vercel/prj_xxx/production", status: "deployed" }

LLM context: never saw "eyJ..."
```

## 7. Intégration gateway

### 7.1 Accès au store

Le `ProjectEnvVarStore` est injecté dans le `GatewayConfig` au boot,
aux côtés du `contextLoader` et de l'`audit`. Les adapters y accèdent
via le contexte d'exécution.

### 7.2 Risque & classification

Les tools `_to_venv` héritent du risque de la lecture source
(ex. `supabase__service_role_to_venv` → `supabase.read-secrets`
ou similaire dans le catalog).

Les tools `_from_venv` héritent du risque de l'écriture
destination (ex. `vercel__upsert_env_from_venv` → `vercel.env-var-write`).

Les tools `venv__list` et `venv__delete` portent un risque propre
à définir dans le catalog (`venv.list` / `venv.delete`).

### 7.3 Audit

Chaque opération venv est logguée dans l'audit_log :

```json
{
  "action": "venv_store",
  "key": "SUPABASE_SERVICE_ROLE_KEY",
  "source": "supabase/api-keys/service_role"
}
```

```json
{
  "action": "venv_deploy",
  "key": "SUPABASE_SERVICE_ROLE_KEY",
  "destination": "vercel/prj_xxx/production"
}
```

La valeur n'apparaît jamais dans l'audit.

## 8. Migration

```
Migration: 00XX_create_project_env_vars.sql
```

Table + RLS enable + pas de policy (service_role only).

## 9. Décisions ouvertes

- **Q1 : Chiffrement applicatif.** Supabase TDE suffit-il, ou faut-il
  une couche AES-256-GCM applicative avec clé dérivée du projet ?
  → v1 : TDE seul. v2 : évaluer si le threat model le justifie.

- **Q2 : Nommage des clés.** Convention rigide (le tool producteur
  décide du nom, ex. `SUPABASE_SERVICE_ROLE_KEY`) ou libre (le LLM
  passe le nom) ? Rigide = moins d'erreurs, libre = plus flexible.
  → Proposé : rigide pour les producteurs built-in, libre pour un
  éventuel `venv__set` générique (hors-scope v1).

- **Q3 : Cleanup.** Faut-il un TTL automatique sur les entrées, ou
  la suppression est-elle toujours explicite via `venv__delete` ?
  → Proposé : pas de TTL en v1. Les secrets projet sont durables.
