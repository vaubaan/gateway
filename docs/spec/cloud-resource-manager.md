# Cloud Resource Manager (CRM) — spec

> **Statut :** spec greenfield. Ce document remplace toute version antérieure
> de la gestion de services / credentials / MCP côté Vauban Core. Le code
> existant (`org_services`, `project_services`, `credential_blobs`,
> `project_manifests.services`, `plugin-host-*`, export `.env` actuel,
> rendu `.mcp.json` runtime) est intégralement retiré dans cette refonte —
> pas de dual-write, pas de migration de données, on repart d'une feuille
> blanche.
>
> **Filiation v2.** Cette spec remplace une codebase précédente
> (**Vauban v2**) archivée sous `legacy/` dans le repo méta
> [github.com/sbw-vauban/vauban](https://github.com/sbw-vauban/vauban),
> déjà checkout localement à `/home/dev/vauban/legacy/` (chemin
> transitoire, à retirer une fois le dev v3 stabilisé). Refonte
> from-scratch — pas de code partagé, pas de migration, pas de compat.
> Un agent d'implémentation peut **consulter ponctuellement** v2 comme
> référence (anciens schémas DB, runbooks, traces de décisions
> implicites) mais ne doit **pas l'absorber en bloc** dans son
> contexte : cette spec est faite pour être auto-portante.

## 0. Vocabulaire

Le CRM raisonne sur 5 mots, distincts et non-interchangeables :

- **CloudProvider** — le SaaS lui-même (GitHub, Vercel, Supabase…). Vit
  dans le catalogue statique de Vauban. Pas une row DB, juste une string
  référencée par les ResourceKinds.
- **ResourceKind** — entrée du catalogue : un type de ressource exposé
  par un Provider. Trois sous-classes :
  - **OrgResourceKind** (ex: `github-org`, `vercel-team`, `supabase-org`)
  - **ProjectResourceKind** (ex: `github-repo`, `vercel-project`, `supabase-project`)
  - **OrgResourceAdminKind** (ex: `github-org-admin`,
    `vercel-team-admin`). Toujours org-scoped, déclare quels
    `ProjectResourceKind[]` il sait gérer (provisionner + rotater).
- **Resource** — l'inventaire concret côté Vauban : une row qui *pointe*
  vers une ressource réelle chez le Provider via un `provider_ref`. Scopée
  org ou project. Une Resource n'**est pas** la ressource cloud ; elle en
  est la trace + l'accès.
- **Access** — l'ensemble des secrets sealed (ZK) nécessaires pour
  utiliser une Resource. Mappés clé→sealed_blob dans `resource_access`.
- **variant** — colonne text optionnelle sur `resources`. Permet de
  coexister plusieurs instances d'un même kind au même scope (ex:
  `supabase-project` en `variant='staging'` et `variant='prod'`).

**Distinction clé :** "provisionner une Resource" ≠ "registrer une
Resource". On *registre* une OrgResource (parce qu'un humain l'a créée
chez le Provider et donne son accès à Vauban). On *provisionne* une
ProjectResource via un Admin (Vauban tape l'API du Provider pour la
créer, depuis le browser de l'user qui détient les creds).

Un **OrgResourceAdmin** porte **deux pouvoirs symétriques** :
provisionner (créer une nouvelle ProjectResource chez le Provider) **et**
rotater (régénérer l'Access d'une ProjectResource existante). Les deux
demandent typiquement les mêmes droits côté Provider (ex: GitHub PAT
`repo:admin` peut à la fois créer un repo et regénérer son deploy token).

### 0.1 Rotation : 3 paths

Chaque `ResourceKind` déclare un `rotationMethod` ∈ :

- **`self`** — la Resource peut rotater son propre Access avec ses
  propres creds (ex: Cloudflare API tokens, AWS IAM keys, GitHub App
  installation tokens). Le browser fait un round-trip direct provider.
- **`admin-mediated`** — la Resource ne peut pas se rotater elle-même ;
  il faut passer par un Admin (ex: GitHub PAT, Supabase service_role,
  Vercel deploy tokens). Le browser charge l'Access de l'Admin, appelle
  `Admin.rotateChildAccess()`.
- **`manual`** — aucune API. Le CRM affiche les `setupDocs` au user qui
  va régénérer le token dans le dashboard du Provider, puis paste +
  seal + PUT (ex: OpenAI key, Anthropic key, certains DSNs).

`OrgResources` sont toujours `manual` — il n'y a pas d'admin "au-dessus"
de l'org.

## 1. Vision

Le **Cloud Resource Manager (CRM)** est le sous-système de Vauban Core qui :

1. **Catalogue** les CloudProviders + ResourceKinds connus de Vauban.
2. **Inventorie** les Resources que possèdent les organizations et leurs
   projects.
3. **Stocke** les Accesses ZK (sealed côté browser, jamais cleartext
   sur Core).
4. **Provisionne** de nouvelles ProjectResources via les Admins
   registrés, sur demande synchrone d'un user connecté.
5. **Tourne (rotate)** les Accesses sur demande synchrone.
6. **Exporte**, scopés à `org` ou `project` (et filtrables par `variant`),
   deux artefacts :
   - un fichier **`.env`** (placeholders ou valeurs unsealed côté browser),
   - un fichier **`mcp.json`** accompagné de son `.env` compagnon.
7. **Exporte** un **`CloudResourceMap`** — JSON read-only de l'inventaire
   complet de l'org, consommé par le Coding Agent Runner (CAR) côté VPS
   client (cf. spec coding-agent-runner.md §8.1). Aucun secret ; juste
   métadonnées + référence aux SecretManagers.

Le CRM vit dans le cloud public (Vauban Core, Next.js + Supabase + Vercel)
et est multi-tenant.

### 1.1 Hors-scope explicite

- **Aucune** notion de `Job`, `JobKind`, `JobExecutor`. Le CRM expose des
  fonctions synchrones de Core, appelées par un user connecté qui fournit
  transitoirement la clé de descellement.
- **Aucune** notion de `plugin-host-*`. Les hôtes de déploiement sortent
  du périmètre.
- **Aucune** action automatique programmée. Une rotation, un provisioning,
  une révocation requièrent toujours un user humain connecté.
- **Aucun** stockage de secrets en clair sur Core.
- **Aucun** provisioning d'**OrgResource**. Les OrgResources sont
  toujours créées manuellement par un humain chez le Provider (signup,
  facturation, MFA, …) ; Vauban se contente de les registrer.

## 2. Domaine

### 2.1 Hiérarchie

```
CloudProvider  (catalogue statique — 'github' | 'vercel' | 'supabase-cloud' | …)
   │
   │  expose
   ├──►  OrgResourceKind                    (catalogue : 'github-org', 'vercel-team', …)
   ├──►  ProjectResourceKind                (catalogue : 'github-repo', 'vercel-project', …)
   └──►  OrgResourceAdminKind     (catalogue : 'github-org-admin', …)
                                              └── declares: manages: ProjectResourceKind[]
                                                    (provisionne + rotate)

Organization
  ├── SecretManager  (1..N — built-in v1 = infisical, BYO workspace ; pluggables v2+)
  ├── Resource (scope='org')      ─ instance d'un OrgResourceKind OU d'un AdminKind
  ├── MCPConfig (scope='org')
  └── Project
        ├── Resource (scope='project')  ─ instance d'un ProjectResourceKind
        │           └── admin_resource? → Resource (un Admin org-scoped)
        └── MCPConfig (scope='project')
```

### 2.2 Définitions

| Entité                          | Définition courte                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User**                        | Compte humain Vauban. Auth Supabase. Peut appartenir à plusieurs Organizations.                                                                                                                                                                                  |
| **Organization**                | Tenant racine. Isolation RLS stricte entre Organizations.                                                                                                                                                                                                        |
| **Project**                     | Sous-unité d'une Organization. Porte ses propres Resources project-level et MCPConfigs.                                                                                                                                                                          |
| **CloudProvider**               | SaaS connu. Statique. Identifié par une string (`github`, `vercel`, `supabase-cloud`).                                                                                                                                                                           |
| **ResourceKind**                | Entrée du catalogue. Trois sous-types (Org / Project / OrgAdmin). Porte schémas, setupDocs, healthCmd, mcpFragment, egressHosts.                                                                                                                              |
| **Resource**                    | Row Vauban qui pointe vers une ressource réelle chez le Provider. Scopée org ou project. Possède une `Access` (sealed creds) + des métadonnées de connexion.                                                                                                    |
| **OrgResourceAdmin**           | OrgResource dont le `ResourceKind` est une `OrgResourceAdminKind`. Toujours `scope='org'`. Tient un Access plus privilégié que le `OrgResourceKind` régulier, qui lui donne le pouvoir de provisionner et rotater les ProjectResources qu'il gère (`manages`). |
| **Access**                      | Bundle `{key → sealed_blob}` rattaché à une Resource, dans `resource_access`. Les blobs sont des sealed-box NaCl multi-recipient.                                                                                                                               |
| **variant**                     | Colonne text libre sur `resources`. Pas une entité. Permet de coexister plusieurs Resources de même kind au même scope.                                                                                                                                          |
| **SecretManager**               | Backend **opaque** de stockage des sealed_blobs (cf. §4 — la crypto ZK vit côté browser, le SM ne voit que du ciphertext). Built-in v1 : `infisical` (BYO workspace Cloud ou self-host). Pluggable v2+ : `vault`, `1password`.                                  |
| **MCPConfig**                   | Bundle `(snapshot mcp.json, snapshot .env)` régénéré à chaque mutation du graph de Resources. Scopé `org` ou `project` (filtrable par `variant`). Persisté pour audit + export reproductible.                                                                   |
| **CloudResourceMap**            | Export JSON de l'inventaire org (Resources + métadonnées + pointeurs SM), consommé par le CAR. **Pas de secret dedans.** Régénéré à la demande via `/exports/cloud-resource-map`. Schéma défini côté CAR (cf. spec coding-agent-runner.md §8.1). |

### 2.3 L'invariant transverse — ZK

> **Aucun Access cleartext ne transite ni ne persiste jamais sur le CRM.**

- Au moment du `put`, le secret est chiffré dans le browser de l'user (sealed-box
  NaCl, recipients = `browser_ephemeral_pubkey` + `runner_pubkey`).
- Au moment du `get`, le CRM renvoie le blob sealed ; le déchiffrement se fait
  soit dans le browser de l'user, soit sur l'Org Runner (injection en session).
- Le Core operator (root sur la DB Vauban) **ne peut rien déchiffrer** sans
  complicité d'un membre de l'org qui branche son browser.

Toute action CRM (création Resource, provisioning, rotation, export)
**requiert** un user connecté. Une action interrompue est retentée
manuellement — le CRM ne stocke aucun state intermédiaire.

## 3. Modèle de données

### 3.1 Tables

```sql
-- Existantes, non modifiées : users, organizations, org_members, projects.

create table secret_managers (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  kind               text not null,        -- 'infisical' (built-in v1) | 'vault' | '1password' | ...
  name               text not null,
  is_default         boolean not null default false,
  config             jsonb not null default '{}',  -- non-sensitive config (endpoint, workspace_id, …)
  auth_sealed_blob   bytea,                        -- token machine-identity du SM, sealed multi-recipient (§4.3)
                                                   -- recipients = org_admins + (runner_pk si org a un CAR)
  created_at         timestamptz not null default now(),
  unique (organization_id, name)
);
-- Exactement un is_default=true par organization (enforced by partial unique index).

create table resources (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references organizations(id) on delete cascade,
  project_id           uuid references projects(id) on delete cascade,
  admin_resource_id    uuid references resources(id) on delete set null,
  provider_name        text not null,            -- 'github' | 'vercel' | 'supabase-cloud' | …
  kind                 text not null,            -- 'github-org' | 'github-repo' | 'github-org-admin' | …
  scope                text not null,            -- 'org' | 'project' (redondant mais commode pour les index/RLS)
  is_admin       boolean not null default false,  -- dérivé de kind, dénormalisé pour les index partiels
  name                 text not null,            -- slug human-readable
  variant              text,                     -- optionnel ; 'staging' | 'prod' | …
  provider_ref         text,                     -- ID provider (e.g. 'acme', 'acme/my-repo', 'prj_xxx')
  console_url          text,
  setup_docs_url       text,
  health_test_cmd      text,
  status               text not null default 'pending',  -- pending | active | failed | detached
  secret_manager_id    uuid not null references secret_managers(id) on delete restrict,
  provider_metadata    jsonb not null default '{}',
  provider_permissions jsonb not null default '{}',
  connection_status    text not null default 'unknown',
  connection_checked_at timestamptz,
  connection_message   text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (organization_id, project_id, name),
  check (name ~ '^[a-z0-9](-?[a-z0-9])*$'),
  check (variant is null or variant ~ '^[a-z0-9](-?[a-z0-9])*$'),
  check (scope in ('org', 'project')),
  check ((scope = 'org'     and project_id is null)
      or (scope = 'project' and project_id is not null)),
  check (admin_resource_id is null or scope = 'project'),  -- only project-resources can have a admin
  check (is_admin = false or scope = 'org')          -- admins are always org-scoped
);

create table resource_access (
  id                   uuid primary key default gen_random_uuid(),
  resource_id          uuid not null references resources(id) on delete cascade,
  key                  text not null,        -- e.g. 'GITHUB_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY'
  sealed_blob          bytea not null,       -- sealed-box multi-recipient (see §4)
  description          text,
  rotated_at           timestamptz not null default now(),
  unique (resource_id, key)
);

create table mcp_configs (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references organizations(id) on delete cascade,
  project_id           uuid references projects(id) on delete cascade,
  variant              text,                 -- filtre optionnel ; doit matcher resources.variant
  mcp_snapshot         jsonb not null,       -- le fichier mcp.json complet
  env_snapshot         jsonb not null,       -- mapping key → sealed_blob_ref (ou placeholder string)
  generated_at         timestamptz not null default now(),
  check (variant is null or variant ~ '^[a-z0-9](-?[a-z0-9])*$')
);

-- Un seul snapshot vivant par (org, project, variant) — UPSERT on regenerate.
-- Pas d'historique en v1. NULLS NOT DISTINCT pour que (project_id NULL, variant NULL)
-- collisionne bien avec lui-même.
create unique index mcp_configs_unique_scope
  on mcp_configs (organization_id, project_id, variant) nulls not distinct;

create table audit_log (
  -- table existante, augmentée d'actions CRM :
  --   resource.registered, resource.provisioned, resource.access.rotated,
  --   resource.access.exported, mcp_config.regenerated, secret_manager.added,
  --   cloud_resource_map.exported, …
);
```

### 3.2 Indices clés

- `resources (organization_id, scope, provider_name, kind)` — listings catalogués.
- `resources (project_id, kind, variant)` — listing project-level.
- `resources (organization_id, is_admin) where is_admin` — picker UI Admins.
- `resource_access (resource_id)` — lookup au moment de l'export.
- `mcp_configs_unique_scope` (UNIQUE) — un seul row vivant par
  `(organization_id, project_id, variant)`. Lookup direct, pas d'historique.

### 3.3 RLS — résumé

**2 rôles au niveau organization, point.** La granularité fine "qui voit
quoi en clair" est entièrement portée par la recipient list crypto
(§4.4), pas par la RBAC SQL. Même mental model que 1Password.

| Table              | member | admin |
| ------------------ | :----: | :---: |
| `secret_managers`  |   R    |  RW   |
| `resources`        |   R    |  RW   |
| `resource_access`  |   R¹   |  RW   |
| `mcp_configs`      |   R    |  RW   |

¹ Un `member` peut *fetch* tous les `sealed_blob` de son org, mais ne peut
*déchiffrer* que ceux où sa pubkey figure dans la recipient list. Un admin
qui veut limiter un member à un sous-ensemble de Resources le fait au
moment du seal en n'incluant pas la pubkey pour les autres blobs.

Stockés dans `org_members(organization_id, user_id, role text not null
default 'member' check (role in ('member', 'admin')))`.

## 4. Cryptographie ZK — clés, distribution, cycle de vie

### 4.0 Le double plan d'accès

Pour qu'un acteur utilise un Access, **deux gates indépendantes** doivent
être franchies — c'est la garantie ZK :

| Plan                    | Mécanisme                                  | Tenu par                        | Bloque…                                              |
| ----------------------- | ------------------------------------------ | ------------------------------- | ---------------------------------------------------- |
| **Plan Vauban (RBAC)**  | RLS Supabase sur `resource_access`         | DB Vauban                       | la *lecture* du row chiffré                          |
| **Plan crypto**         | recipient list dans le bundle sealed-box   | Les recipients (browsers/runner)| le *déchiffrement* du payload                        |

L'opérateur Vauban contrôle le plan RBAC (il peut, en théorie, accorder
read-access SQL à n'importe qui) mais **ne contrôle pas** le plan crypto :
sans la clé privée d'un recipient listé, aucun cleartext.

### 4.1 Identité crypto par user

Chaque user Vauban possède **une** keypair X25519 long-terme.

```
clé privée  =  random 32 bytes (libsodium crypto_box_keypair)
clé publique = X25519(clé privée)
fingerprint = sha256(clé publique) tronqué 16 bytes hex
```

**Cycle de génération** (idempotent, lazy au premier login d'un device) :

```
1. User log in (email + password)  → Vauban auth OK (bcrypt hash matche)
2. Device fetch /api/crm/v1/me/crypto-key
   ── si row existe : récupère { wrapped_sk, kdf_salt, public_key, kdf_params }
   ── si row absente : génère keypair locale, va à l'étape 5
3. Device dérive KEK = argon2id(password, kdf_salt, m=64MiB, t=3, p=1)
4. Device unwrap sk = XChaCha20-Poly1305-decrypt(wrapped_sk, KEK)
5. Si génération neuve : wrap sk avec KEK fraîche, POST /me/crypto-key
6. Device cache sk localement (cf §4.1.1) — jamais ré-uploadé en clair.
```

**Pas de passphrase distincte.** Le mot de passe Vauban sert à la fois à
l'auth (bcrypt server-side) et à la dérivation du KEK (KDF client-side).
Vauban ne stocke jamais le mot de passe en clair, juste son hash bcrypt
+ la version wrappée de la sk de l'user.

### 4.1.1 Multi-device : 1 keypair, N caches locaux

**Le user a une seule keypair X25519**, partagée entre tous ses devices
(browser laptop, browser mobile, CLI sur poste de dev, etc.). Le
mécanisme de partage = chaque device pull la même `wrapped_sk` depuis
Vauban au premier login, l'unwrap localement avec le password.

| Type de device       | Cache de la sk déballée                                             | TTL                                       |
| -------------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| Browser (web)        | mémoire JS seulement, `sessionStorage`-like                         | jusqu'au logout / refresh / fermeture tab |
| CLI (Vauban CLI)     | OS keychain (libsecret/Keychain/wincred), wrapped par session OS    | jusqu'au `vauban logout` ou expire        |
| Mobile (futur)       | Secure Enclave / Android Keystore                                   | configurable                              |

Vauban ne tient **aucun registre des devices**. Pas de table
`user_crypto_devices`, pas de revocation per-device. Conséquence
explicite : **un device compromis = identité user compromise**. La
parade est password rotation (§4.6) — qui invalide le `wrapped_sk` sur
tous les devices simultanément (les caches locaux restent valides mais
le prochain login forcera une re-fetch). Pour la révocation crypto
réelle, voir §4.7 (lost password = nouvelle keypair).

> **Alternative rejetée :** 1 keypair par device (modèle Signal/WhatsApp
> Web). Plus de granularité de révocation, mais recipient list 3-5×
> plus longue + onboarding device complexe (QR ou admin re-seal). Pas
> retenu pour v1 ; à reconsidérer si "perdu mon laptop" devient un cas
> d'usage fréquent.

**Table** :

```sql
create table user_crypto_keys (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  public_key         bytea not null,
  fingerprint        text not null,
  wrapped_private_key bytea not null,
  kdf_salt           bytea not null,
  kdf_params         jsonb not null default '{"m":67108864,"t":3,"p":1,"alg":"argon2id"}',
  created_at         timestamptz not null default now(),
  rotated_at         timestamptz not null default now()
);
```

### 4.2 Identité crypto du Runner

Une keypair X25519 par Org Runner, générée à l'enregistrement du Runner :

- `private.key` persisté sur disque LUKS du VPS, mode 0600, owner runner.
- `public_key` POSTé à Vauban via le bootstrap auth (bearer org-admin), et
  persisté dans `runners.public_key` + `runners.fingerprint`.

Le Runner peut tourner sa keypair à tout moment (op `runner key rotate`) ;
la nouvelle pubkey remplace l'ancienne dans `runners` et **tous les
blobs existants** doivent être re-sealed (cf §4.5).

### 4.3 Format du sealed_blob (multi-recipient)

```jsonc
// resource_access.sealed_blob
{
  "v": 1,
  "recipients": [
    // un per (user|runner) qui doit pouvoir déchiffrer ce blob :
    { "fp": "abcd…", "ct": "<base64>" },   // user Alice
    { "fp": "ef01…", "ct": "<base64>" },   // user Bob
    { "fp": "2345…", "ct": "<base64>" }    // Org Runner
  ]
}
```

Chaque `ct = libsodium.crypto_box_seal(cleartext_utf8, recipient_pubkey)`.
Chaque recipient ne peut déchiffrer **que** sa propre entrée.

**Pas de DEK envelope en v1.** Chaque blob est sealed directement pour
chaque recipient. Le surcoût : N · 48 octets par blob (où N = nb de
recipients). Pour 50 users × 500 resources × 5 keys × 50 = ~6 MB de
ciphertext total, négligeable. Si scaling pose problème en v2, on
introduira une couche DEK/KEK.

### 4.4 Calcul de la recipient list

Au moment où un admin `put` un Access (ou re-seal, cf §4.5), le browser
calcule la **default recipient list** :

```
default_recipients(resource) =
    {pubkeys of all org members}             -- la RBAC SQL est sans rôle ici
  ∪ (Runner pubkey of the org   if resource.kindClass != 'org-admin'
                                 else ∅)
```

L'admin peut **override** cette liste au moment du seal pour exclure
certains members (ex: "Bob ne doit pas voir les creds du project
`backend`"). C'est *la* surface de contrôle d'accès fine — pas la RBAC
SQL, qui est volontairement plate (member/admin).

**Convention `org-admin` = no-runner** : les Accesses d'un
`OrgResourceAdmin` ne sont *jamais* sealed pour le Runner. C'est la
seule gate qui empêche un cred admin-tier d'arriver en env var dans une
Coding Session : si le Runner n'est pas dans la recipient list, il ne
peut pas déchiffrer, point. Pas besoin de flag SQL `usage` parallèle.

Les Accesses d'`OrgResourceKind` (read-only) et `ProjectResourceKind`
incluent le Runner par défaut — le Runner doit pouvoir injecter
`GITHUB_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, etc.

Le CRM expose un endpoint qui renvoie la default list :

```
GET /api/crm/v1/resources/:rId/access/:key/recipients
  → { defaults: [ { user_id?, runner_id?, public_key, fingerprint }, … ] }
```

Le browser affiche au user les fingerprints (+ noms) et lui laisse
décocher des members avant le seal (TOFU + validation visuelle des
nouvelles pubkeys).

### 4.5 Distribution = re-sealing

**Cas qui déclenchent un re-seal** :

| Événement                                       | Recipients à ajouter / retirer        |
| ----------------------------------------------- | ------------------------------------- |
| User invité dans une org (rôle admin/owner)     | +user (sur **tous** les blobs de l'org) |
| User invité dans un project (rôle dev)          | +user (sur les blobs du project)      |
| User retiré d'une org/project                   | −user (et **rotate** le secret sous-jacent) |
| User rotate sa keypair (mot de passe perdu)     | +new pubkey, −old pubkey              |
| Runner rotate sa keypair                        | +new pubkey, −old pubkey              |

**Mécanisme** :

```
1. SM marque les blobs concernés : resource_access.recipients_stale = true.
   (Index partiel + endpoint /needs-reseal pour le filtrage.)
2. Le prochain admin online avec read-access et la sk déverrouillée
   est sollicité (banner dans l'UI sur la page Resources) :
       "X access blobs need re-sealing to grant access to <new member>.
        Re-seal now"
   Action explicite, jamais background.
3. Browser : pour chaque blob `b` :
   a. GET old recipients & ct → unseal ct pour son fingerprint
   b. fetch new recipients list (§4.4)
   c. seal(cleartext, [new_recipients])
   d. PUT resealed bundle ; SM clear recipients_stale.
4. Audit log : { actor, action='access.resealed', subject={blob_id}, added/removed pubkeys }.
```

**Côté du new member** (tant que le re-seal n'est pas fait) :

- Il voit l'inventaire (member can read metadata).
- Il fetch les `sealed_blob` mais ne peut rien déchiffrer.
- Sur chaque page Resource où il a 0 blob déchiffrable, banner :
      "Contacter un admin pour qu'il active votre accès."
- Pas de blocage du login ni des autres parties de Vauban. Le member
  peut naviguer, consulter, mais l'export `.env` lui renverra que des
  placeholders tant que les blobs n'ont pas été re-sealés pour lui.

**Important** : un user retiré d'un project conserve techniquement tous les
blobs qu'il a déjà déchiffrés en mémoire. **Pour révoquer réellement, il
faut rotater le secret sous-jacent** chez le Provider (§7.4). C'est un
coût intrinsèque à la ZK — l'UI le rappelle au moment de la révocation.

### 4.6 Rotation du mot de passe

```
1. User → POST /me/password { old, new }
2. Vauban : verify bcrypt(old) ; update bcrypt(new). CRM-agnostic.
3. Browser : récupère { wrapped_sk, kdf_salt } (déjà déballé en mémoire
              suite au login OK).
4. Browser : dérive new_KEK = argon2id(new, fresh_salt).
5. Browser : wrap sk avec new_KEK → POST /me/crypto-key { wrapped_sk, kdf_salt }.
6. La keypair X25519 est **inchangée** → aucun re-seal de blob nécessaire.
```

### 4.7 Perte du mot de passe

**Aucune récupération côté Vauban.** Le wrapped_sk est inutilisable sans
le mot de passe ; Vauban ne le voit jamais.

Flow de récupération :

```
1. User reset son mot de passe via email (auth Supabase classique).
2. Browser : ne peut PAS déballer l'ancien wrapped_sk → génère une
   **nouvelle keypair** X25519.
3. POST /me/crypto-key { public_key=new, wrapped_private_key=new(wrap(new_sk, new_KEK)) }
   en mode `replace=true` + flag `crypto.identity.rotated`.
4. SM marque tous les blobs où ce user était recipient comme
   `recipients_stale = true` avec le **nouveau fingerprint**.
5. Le user perd l'accès à tous ses blobs tant qu'un autre membre n'a pas
   re-sealed pour lui. Banner UI dédié.
6. Si aucun autre membre n'a accès (org solo) → l'org est cuite côté
   ZK : il faut rotater chaque secret sous-jacent chez le Provider.
   Documenté comme coût explicite.
```

### 4.8 Le SecretManager pluggable et le double plan

Le `SecretManager` choisi (Infisical en v1, Vault / 1Password en v2+)
ne change **rien** au plan crypto : c'est toujours un bundle multi-recipient
sealed côté browser. Le SecretManager est juste le *store* où vit le
bundle.

⚠ Cas dégradé : certains backends (Vault Transit, GCP KMS) font leur
propre crypto serveur-side. Si l'org choisit un de ces backends, elle
accepte un autre modèle de confiance (le serveur Vault peut déchiffrer).
Le CRM marque ce backend comme `kindClass='managed'` et désactive le
sealed-bundle ; les CloudService.Env sont alors stockés en clair côté
backend, l'opérateur Vault est le TCB. Hors-scope v1.

### 4.9 Opérations canoniques (mise à jour)

| Op                              | Browser                                                | CRM                                                  | Runner                       |
| ------------------------------- | ------------------------------------------------------ | --------------------------------------------------- | ---------------------------- |
| **first login**                 | gen keypair OR unwrap sk avec password                 | GET/PUT user_crypto_keys                            | —                            |
| **put Access**                  | fetch recipients → seal pour chacun → POST bundle      | persist blob + audit                                | —                            |
| **get Access (use)**            | GET bundle → unseal son entry avec sk en mémoire       | renvoie bundle + audit "read"                       | —                            |
| **rotate Access (self)**        | unseal old → kind.rotateSelf → seal new pour recipients | persiste new blob                                   | —                            |
| **rotate Access (admin)**       | unseal admin's → admin.rotateChildAccess → seal new    | persiste new blob                                   | —                            |
| **re-seal on membership change**| unseal old → seal pour new recipient set → PUT bundle  | clear recipients_stale + audit                      | —                            |
| **inject Access en session**    | —                                                       | renvoie bundle au Runner sur poll                   | unseal son entry, `env -i`   |
| **change password**             | re-wrap sk avec KEK dérivée du new password            | persist new wrapped_sk + new salt                   | —                            |
| **lost password**               | gen new keypair + wrap                                  | persist new pubkey + mark blobs stale + email admin | —                            |
| **export `.env`**               | unseal chacun, écrit fichier local                     | renvoie list bundles + audit "export"               | —                            |

## 5. Catalogue + plugins

### 5.1 Contrat `ResourceKind`

```ts
type KindClass = 'org' | 'project' | 'org-admin';

type RotationMethod = 'self' | 'admin-mediated' | 'manual';

interface ResourceKind {
  readonly id: string;                  // 'github-org' | 'github-repo' | 'github-org-admin'
  readonly provider: string;            // 'github'
  readonly kindClass: KindClass;
  readonly displayName: string;
  /** Markdown affiché au user pour l'aider à créer manuellement la
   *  ressource côté Provider et générer le token nécessaire. */
  readonly setupDocs: string;
  /** Schéma des clés d'Access exposées par ce kind. */
  readonly accessSchema: Readonly<Record<string, AccessKeySpec>>;
  /** Schéma des metadata provider stockées dans resources.provider_metadata. */
  readonly metadataSchema: ZodSchema;
  /** Commande idempotente, exit 0 = healthy. Exécutée sur l'Org Runner. */
  healthTestCmd(meta: unknown, access: Record<string, string>): string;
  /** Fragment mcp.json à inclure dans les MCPConfigs. null = pas de MCP. */
  mcpFragment?(meta: unknown): McpServerFragment | null;
  /** Hosts d'egress requis pour le SDK + le MCP server (mitmproxy). */
  egressHosts(meta: unknown): readonly string[];
  /** Comment cette Resource rotate son Access. Voir §0.1. */
  readonly rotationMethod: RotationMethod;
  /** Si rotationMethod='self', l'implémentation de la rotation. */
  rotateSelf?(access: Record<string, string>, accessKey: string): Promise<string>;
}

interface OrgResourceAdminKind extends ResourceKind {
  readonly kindClass: 'org-admin';
  /** IDs des ProjectResourceKinds que cet Admin sait gérer (provisionner + rotater). */
  readonly manages: readonly string[];

  /** Liste les ressources existantes côté Provider (adoption). */
  listChildren(access: Record<string, string>): Promise<ProviderChild[]>;

  /** Crée une nouvelle ressource côté Provider. */
  createChild(access: Record<string, string>, spec: unknown): Promise<ProviderChild>;

  /** Détruit une ressource côté Provider. */
  destroyChild(access: Record<string, string>, providerRef: string): Promise<void>;

  /** Rotate l'Access d'une child Resource. Appelé quand
   *  child.kind.rotationMethod='admin-mediated' et qu'on tape l'API du
   *  provider depuis le browser avec l'Access de l'Admin. Renvoie la
   *  nouvelle valeur en clair (browser-side uniquement). */
  rotateChildAccess(
    access: Record<string, string>,
    childProviderRef: string,
    accessKey: string,
  ): Promise<string>;
}
```

**Différences clés avec l'ancien contrat `ServicePlugin` :**

- Le triplet `provisionProject` / `destroyProject` / `rotateProject` est
  remplacé par `createChild` / `destroyChild` exécutés **côté browser** :
  Vauban Core ne touche jamais aux APIs Provider qui demandent des creds.
- `orgWizard` / `projectWizard` retirés. Remplacés par `setupDocs`
  markdown : le CRM affiche les instructions, l'user les suit, paste le
  token résultant dans le browser qui seal et POST.
- `configureCli` / `configureCi` retirés du contrat. CI sync = sous-système
  séparé à recréer plus tard si besoin.
- Le catalogue distingue 3 `kindClass` au lieu d'une seule notion de
  "service plugin" — c'est plus simple d'avoir 3 contrats étanches qu'un
  seul polymorphe.

### 5.2 Contrat `SecretManager`

**Interface partagée** avec le CAR (cf. spec coding-agent-runner.md §8.2) :
même nom, même shape, même clé d'adressage `(resourceId, accessKey)`. Le
CRM utilise les 4 méthodes ; le CAR n'utilise que la moitié read-only.
Garder une seule interface évite tout drift entre les deux sous-systèmes
et permet à un plugin (ex: `infisical`) d'être implémenté une fois et
réutilisé.

```ts
interface SecretManager {
  /** Identifiant kind du plugin. */
  readonly kind: string;          // 'infisical' (v1) | 'vault' | '1password' | ...

  /** Identifiant d'instance (cas où la même org a 2 backends du même kind). */
  readonly name: string;          // 'default' | 'vault-prod' | ...

  // ── Read API (utilisée côté CRM ET côté CAR) ─────────────────────
  get(resourceId: string, accessKey: string): Promise<SealedBlob>;
  list?(resourceId: string): Promise<string[]>;

  // ── Mutation API (utilisée UNIQUEMENT côté CRM) ──────────────────
  put(resourceId: string, accessKey: string, blob: SealedBlob): Promise<void>;
  revoke(resourceId: string, accessKey: string): Promise<void>;
}

type SealedBlob = {
  v: 1;
  recipients: Array<{ fingerprint: string; ct: string /* base64 */ }>;
};
```

**Pas d'`AccessScope` union.** Tous les blobs sont rattachés à une
Resource (table `resource_access`) ; la clé naturelle est donc
`(resource_id, key)`. Les filtres par org / project / variant se font
côté CRM SQL avant d'appeler `get` — c'est *l'inventaire* (Resources)
qui porte la notion de scope, pas le store de secrets.

**Built-in v1 (CRM-side)** : un seul plugin livré, `infisical`, qui
POST/GET les `sealed_blob` dans le workspace Infisical de l'org (Cloud
ou self-host — *BYO*). Infisical ne voit que du **ciphertext opaque**
(le bundle multi-recipient sealed-box §4.3) ; ni Vauban Core ni
Infisical ne peuvent déchiffrer. Les autres backends (`vault`,
`1password`) sont des stubs `throw NotImplemented` en v1.

**Built-in v1 (CAR-side)** : même plugin `infisical`, en mode pull
depuis le même workspace, avec cache local (cf. spec
coding-agent-runner.md §8.3).

**Bootstrap auth Infisical** : chaque `secret_managers` row porte dans
`config` le `workspace_id` + `endpoint` (non-sensibles) ; le token
machine-identity Infisical est lui-même stocké en sealed_blob dans une
colonne dédiée `secret_managers.auth_sealed_blob` (sealed multi-recipient
pour `org_admins ∪ runner_pk`). Première opération sur le SM = unseal
côté browser → utilisation transitoire du token en mémoire pour
authentifier les appels Infisical. Le CAR fait pareil côté VPS avec sa
`runner.key`.

### 5.3 Catalogue statique

Le catalogue vit dans `@vauban/crm-catalog` :

```
packages/crm-catalog/src/
  index.ts                       # exports : CATALOG: ResourceKind[]
  providers/
    github/
      org.ts                     # OrgResourceKind        ('github-org')
      org-admin.ts               # OrgResourceAdminKind   ('github-org-admin', manages: ['github-repo'])
      repo.ts                    # ProjectResourceKind    ('github-repo')
    vercel/
      team.ts                    # OrgResourceKind        ('vercel-team')
      team-admin.ts              # OrgResourceAdminKind   ('vercel-team-admin', manages: ['vercel-project'])
      project.ts                 # ProjectResourceKind    ('vercel-project')
    supabase-cloud/
      org.ts                     # OrgResourceKind        ('supabase-org')
      org-admin.ts               # OrgResourceAdminKind   ('supabase-org-admin', manages: ['supabase-project'])
      project.ts                 # ProjectResourceKind    ('supabase-project')
```

Un endpoint `/api/crm/v1/catalog` renvoie ce contenu (sans logique
runtime, juste les metadata sérialisables : `id`, `provider`, `kindClass`,
`displayName`, `setupDocs`, `accessSchema`, `manages?`, `rotationMethod`) —
pour que le WebUI puisse rendre la page "+ add Resource".

## 6. API REST

Préfixe : `/api/crm/v1`.

### 6.1 Catalogue (lecture seule, public-ish)

```
GET    /catalog                              -- list ResourceKinds
GET    /catalog/:kindId                      -- single kind + setupDocs
```

### 6.2 SecretManagers

```
GET    /orgs/:orgId/secret-managers
POST   /orgs/:orgId/secret-managers          -- v1 : kind='infisical' uniquement
                                             --   body: { name, config: { workspace_id, endpoint },
                                             --           auth_sealed_blob }
PATCH  /orgs/:orgId/secret-managers/:smId    -- set default, rotate auth_sealed_blob
DELETE /orgs/:orgId/secret-managers/:smId
```

### 6.3 Resources

```
GET    /orgs/:orgId/resources?scope=org|project&project=:pid&variant=:v&kind=:k&isAdmin=true|false
POST   /orgs/:orgId/resources
       body: { kind, name, project_id?, variant?, provider_ref, metadata }
GET    /orgs/:orgId/resources/:rId
PATCH  /orgs/:orgId/resources/:rId
DELETE /orgs/:orgId/resources/:rId
POST   /orgs/:orgId/resources/:rId/health    -- runner runs healthTestCmd, reports back
POST   /orgs/:orgId/resources/:rId/refresh   -- re-pull provider_metadata
```

### 6.4 Access (sealed creds rattachées à une Resource)

```
GET    /orgs/:orgId/resources/:rId/access             -- list clés, pas valeurs
GET    /orgs/:orgId/resources/:rId/access/:key        -- renvoie sealed_blob
PUT    /orgs/:orgId/resources/:rId/access/:key        -- body: { sealed_blob }
POST   /orgs/:orgId/resources/:rId/access/:key/rotate -- workflow §4.3
DELETE /orgs/:orgId/resources/:rId/access/:key
```

### 6.5 Provisioning (via un Admin)

```
POST   /orgs/:orgId/resources/:adminId/provision
       body: { childKind, name, project_id, variant?, spec }
       → 201 { resource_id }     -- crée la nouvelle ProjectResource

DELETE /orgs/:orgId/resources/:provisionedId/destroy-cloud-resource
                                      -- contrairement à DELETE /resources/:id
                                      -- qui détache juste, celui-ci appelle aussi
                                      -- destroyChild sur l'Admin parent
```

La distinction `DELETE /resources/:id` (juste détacher la row Vauban) vs
`/destroy-cloud-resource` (détacher + destroyChild côté Provider) évite
les destructions involontaires.

### 6.6 MCPConfigs

```
GET    /orgs/:orgId/mcp-configs?project=:pid&variant=:v
POST   /orgs/:orgId/mcp-configs/regenerate?scope=org|project&id=:pid&variant=:v
```

Régénération idempotente, **UPSERT** : calcule la liste des Resources
visibles au scope demandé, filtre celles dont le `kind.mcpFragment()`
est non-null, union, écrase la row existante de
`(org, project?, variant?)` (no-op si byte-équivalent — on garde
`generated_at` inchangé pour éviter le bruit). Pas d'historique des
snapshots ; pour audit, voir l'`audit_log` (entrée `mcp_config.regenerated`
avec hash du snapshot).

### 6.7 Exports

```
POST   /orgs/:orgId/exports/env                 -- body: { scope, scopeId, variant?, format='dotenv'|'json' }
POST   /orgs/:orgId/exports/mcp                 -- body: { scope, scopeId, variant? }
                                                --   → { mcp_json, env_dotenv (placeholders) }
POST   /orgs/:orgId/exports/cloud-resource-map  -- body: {}    (toujours scopé org entière)
                                                --   → JSON conforme au schéma CAR §8.1
```

Le CRM renvoie les sealed_blobs + la table des placeholders. Le browser
unseal côté client et écrit les fichiers. **Pas de cleartext jamais
servi par une route Vauban.**

#### 6.7.1 `POST /exports/cloud-resource-map`

Génère le fichier JSON consommé par le CAR (cf. spec
coding-agent-runner.md §8.1). Sortie idempotente (même org + même état
DB → même bytes, hors `exported_at`). **Aucun secret** dans la sortie ;
juste métadonnées + référence au `(secret_manager.kind, .name)` qui
détient chaque Access.

```jsonc
// réponse
{
  "version": 1,
  "exported_at": "2026-05-21T10:00:00Z",
  "organization_id": "acme",
  "resources": [
    {
      "id": "<uuid>",
      "scope": "org" | "project",
      "project_id": "<slug?>",
      "variant": "<staging|prod|null>",
      "kind": "github-org",
      "name": "acme-gh",
      "provider_metadata": { /* resources.provider_metadata */ },
      "mcp_fragment": { /* kind.mcpFragment(meta) */ },
      "egress_hosts": ["api.github.com"],
      "access_keys": [
        { "key": "GITHUB_TOKEN", "usage": "session-injectable" }
      ],
      "secret_manager": { "kind": "infisical", "name": "default" }
    }
    // ...
  ]
}
```

**Filtrage `usage`** : une `access_key` est `session-injectable` ssi le
Runner est recipient du sealed_blob correspondant (§4.4). Sinon elle
sort comme `browser-only`. Cette projection se fait côté SQL sans
déchiffrer quoi que ce soit — la recipient list est lisible en clair
dans `resource_access.sealed_blob`.

**Côté CAR** : aucun export companion à fournir, le CAR pull directement
depuis le même workspace Infisical (cf. spec coding-agent-runner.md
§8.3). Workflow opérateur : `scp` le `cloud-resource-map.json` vers le
VPS, `POST /v1/resource-map/refresh` côté CAR — le CAR rafraîchit son
cache Infisical automatiquement à ce moment-là.

## 7. Workflows

### 7.1 Registrer une OrgResource (ex : GitHub org existante)

```
1. User → CRM   : POST /resources { kind='github-org', name='acme',
                                   provider_ref='acme', metadata={...} }
2. CRM → User   : 201 (row status='pending', renvoie setupDocs markdown).
3. User suit setupDocs chez GitHub, génère un PAT (read-only ou r/w selon usage).
4. User (browser) : seal(PAT, [my_user_pk, all_other_eligible_users_pk, runner_pk]).
5. User → CRM   : PUT /resources/:rId/access/GITHUB_TOKEN { sealed_blob }.
6. CRM          : persist blob ; audit ; status='active'.
7. (optionnel) POST /resources/:rId/health → Runner exécute healthTestCmd
                → connection_status='connected'.
```

### 7.2 Registrer un OrgResourceAdmin (ex : GitHub org avec PAT admin)

Identique à §7.1 mais avec `kind='github-org-admin'`. Différences :
`is_admin=true`, et le PAT requis est scopé `repo:admin` (peut créer
des repos + regénérer leurs deploy tokens) au lieu d'un read-only.

Une org peut très bien avoir à la fois une `github-org` registrée
(read-only, pour observation/MCP) **et** un `github-org-admin` séparé
(avec PAT plus privilégié) — ce sont deux Resources distinctes pointant
vers la même org GitHub. Principle of least privilege par défaut : on
ne donne le PAT admin qu'au moment où on veut provisionner ou rotater.

### 7.3 Provisionner une ProjectResource via un Admin

```
1. User (browser) → GET /resources/:adminId/access/GITHUB_TOKEN → blob.
                    unseal côté browser.
2. User (browser) → catalog.kind('github-org-admin')
                      .createChild(access={GITHUB_TOKEN}, spec={name:'my-repo'})
                    → appel HTTPS vers api.github.com depuis le browser (CORS).
3. User → CRM   : POST /resources/:adminId/provision {
                   childKind='github-repo', name='my-repo',
                   project_id='…', variant=null,
                   spec: { /* server-relayed for audit but never with creds */ }
                 }
4. CRM          : crée une row resources (scope='project',
                 admin_resource_id=adminId,
                 provider_ref='acme/my-repo'). status='pending'.
5. User (browser) : selon le kind, génère un PAT scopé au repo (UI guidée
                    par setupDocs), seal, PUT /access/GITHUB_TOKEN sur la
                    nouvelle Resource.
```

### 7.4 Rotation d'un Access

```
1. User → CRM   : POST /resources/:rId/access/:key/rotate
2. CRM → User   : 202 (rotation requires browser interaction).
                  Renvoie aussi r.kind.rotationMethod pour guider le browser.
3. (dispatch selon rotationMethod) :
   ── rotationMethod='self' ────────────────────────────────────────
   3a. browser : GET old blob, unseal, call kind.rotateSelf(...)
                 (round-trip direct provider), seal new, PUT.
   ── rotationMethod='admin-mediated' ──────────────────────────────
   3b. browser : look up r.admin_resource_id (must exist),
                 GET admin's Access, unseal admin's creds,
                 call admin.kind.rotateChildAccess(admin_access,
                   r.provider_ref, accessKey),
                 seal new, PUT.
   ── rotationMethod='manual' ──────────────────────────────────────
   3c. browser : afficher setupDocs ; user va régénérer côté Provider ;
                 paste, seal, PUT.
4. CRM          : audit ; increment rotated_at.
5. Runner détecte l'update au prochain poll session-start → re-injecte la
   nouvelle valeur dans toute session future.
```

Pas de rotation automatique. Pas de cron. Si une Resource a
`rotationMethod='admin-mediated'` mais `admin_resource_id IS NULL`, le CRM
refuse en 409 avec un message explicatif ("attach an admin first or rotate
manually via setupDocs").

### 7.5 Export `.env` pour `(project=P, variant='staging')`

```
1. User → CRM   : POST /exports/env { scope='project', scopeId=P, variant='staging' }.
2. CRM          : sélection des Resources visibles à ce scope :
                   - tous (project_id=P, variant='staging' OR variant IS NULL)
                   - + tous (organization_id=org(P), project_id=null)
                 union de tous leurs resource_access.
3. CRM → User   : liste { key, sealed_blob, source_resource_id }.
4. User (browser) : unseal chacun (avec sa sk en mémoire), écrit .env
                    localement. Les blobs où l'user n'est pas recipient
                    apparaissent en placeholder + flag "no access".
```

Sans `variant`, on inclut tout le projet. Avec `variant='staging'`, on
inclut les Resources `staging` + celles sans variant (qui valent pour
toutes les variantes : ex. le repo GitHub).

## 8. RBAC

**2 rôles, point.** `member` pour la lecture, `admin` pour l'écriture.
Pas de rôle viewer / dev / po / project-membership : la granularité fine
"qui voit quoi en clair" est portée par la **recipient list crypto**
(§4.4), pas par la RBAC SQL.

| Action                                          | member | admin |
| ----------------------------------------------- | :----: | :---: |
| Read tout (Resources, Access sealed, MCPConfigs)|   ✅   |  ✅   |
| Write Resource (register, PATCH, DELETE)        |   ❌   |  ✅   |
| Provision via un Admin                          |   ❌   |  ✅   |
| Destroy-cloud-resource (irréversible)           |   ❌   |  ✅¹  |
| Write/rotate `resource_access`                  |   ❌   |  ✅   |
| Régénérer MCPConfig                             |   ❌   |  ✅   |
| Exporter `.env` / `mcp.json`                    |   ✅²  |  ✅   |
| Ajouter / changer SecretManager                 |   ❌   |  ✅   |

¹ Confirmation UI explicite obligatoire ("type the resource name"). Ce
n'est pas du RBAC, c'est de l'UX anti-fatigue.

² L'export renvoie des `sealed_blob`. Le browser du member n'unseal que
ceux où il est recipient. Pas de surface RBAC à protéger ici — la crypto
le fait.

**Pas de flag policy-level "browser-only / session-injectable".** La
distinction est uniquement crypto : si la pubkey du Runner n'est pas
recipient d'un blob, le Runner ne peut pas le déchiffrer — point. Par
convention (§4.4), les Accesses des `OrgResourceAdmin` ne sont pas
sealed pour le Runner (humains uniquement) ; les Accesses des
`ProjectResource` le sont. La query CRM se contente de filtrer par
`(org_id, project_id, variant)`.

**Comment limiter un member à un sous-ensemble de Resources ?** En
n'incluant pas sa pubkey dans la recipient list des autres blobs au
moment du seal. C'est une décision **par-blob, prise par l'admin
auteur**, pas un rôle global. Si tu veux que Bob ne voie *que* les
creds du project `frontend` :
- au moment où tu seal un Access du project `backend`, tu n'inclus pas la
  pubkey de Bob ;
- Bob peut fetch le blob (RLS le laisse passer), mais ne peut pas le
  déchiffrer.

## 9. Audit

Toute mutation CRM produit une entrée `audit_log` :

```jsonc
{
  "actor_user_id": "…",
  "scope": { "org": "…", "project": "…?", "variant": "…?" },
  "action": "resource.access.rotated",
  "subject": { "resource_id": "…", "access_key": "GITHUB_TOKEN" },
  "at": "2026-05-19T…"
}
```

Lecture pour les members, pas de mutation depuis l'UI. Conservation
indéfinie en v1 (purge à faire ultérieurement).

## 10. Sécurité

- **No cleartext logs.** Routes renvoyant un sealed_blob redact la valeur
  systématiquement dans les logs serveur.
- **No CORS bypass.** Les appels provider depuis le browser passent par
  les origines fournisseurs ; le CRM n'expose pas de proxy générique.
- **No service account flow.** Tout est attaché à un user humain. Pas de
  bot Vauban qui détient des creds permanents.
- **Health checks isolés.** `healthTestCmd` tourne dans un container
  sysbox éphémère sur l'Org Runner, jamais sur Core, avec egress
  allowlist limité aux `egressHosts` du kind.
- **Egress allowlist par session.** Union(runner canon, kinds.egressHosts)
  → mitmproxy par session.
- **Rate limits** sur `/access/*` et `/exports/*` : 60 req/min par user,
  300 req/min par org.

## 11. UX

### 11.1 Pages

- `/orgs/:slug/resources` — listing global. Filtres : provider, kindClass
  (org / project / org-admin), variant, status. Boutons "+ Register"
  (manual) et "+ Provision via …".
- `/orgs/:slug/resources/new` — wizard : pick kind, show setupDocs,
  paste token (sealed côté browser).
- `/orgs/:slug/resources/:rId` — détail : metadata provider, accesses
  (clés, pas valeurs), bouton "Test now" (health), audit log local.
  Si Admin : section "Provisioned resources" listant les
  ProjectResources créées via cet Admin.
- `/orgs/:slug/projects/:name/resources` — vue project-level, groupée par
  variant.
- `/orgs/:slug/projects/:name/exports` — boutons "download .env",
  "download mcp.json", sélecteur de variant (none / staging / prod / …).
- `/orgs/:slug/secret-managers` — owner only.
- `/orgs/:slug/audit?subject=cloud-resource-manager` — filtre audit.

### 11.2 Patterns

- **Sealed-box uniquement côté browser.** Tous les writes passent par un
  composant React `<SealedInput>` qui (i) génère le bundle multi-recipient,
  (ii) wipe le state local après PUT.
- **Stale recipients banner.** À chaque login, le device check
  `recipients_stale` sur les blobs accessibles ; s'il y en a, banner
  "X blobs need re-sealing for new members" avec action explicite
  (cf §4.5).
- **Status badges.** Chaque Resource affiche `connection_status`
  + `connection_checked_at`. Bouton "Test now" → §6.3 `/health`.

## 12. Tests

Trois couches, avec posture "no-mock" explicite à partir de l'E2E.

### 12.1 Unit (Vitest)

- Chaque `ResourceKind` du catalogue : `mcpFragment`, `healthTestCmd`,
  `egressHosts`, `accessSchema`, `rotationMethod`.
- Pour les `OrgResourceAdminKind` : signatures de `listChildren` /
  `createChild` / `destroyChild` / `rotateChildAccess`. Pas d'appel
  provider à ce niveau — juste les schémas + invariants purs.
- SecretManager `infisical` : encode/decode bundle multi-recipient,
  round-trip seal/unseal, refus de bundle sans la pubkey de l'auteur.
- Crypto property tests : Argon2id KDF deterministic, XChaCha20-Poly1305
  round-trip, refus de wrap avec un salt rejoué.

### 12.2 Integration (Vitest + Supabase test container)

- API CRM end-to-end, **sans browser** : RLS, recipient list, audit
  log, mutation de membership et re-seal flag.
- Pas d'appel provider externe non plus à ce niveau.

### 12.3 E2E (Playwright) — **vraies ressources cloud, zéro mock**

C'est la posture de référence pour la confiance dans le code : un E2E
qui passe = la chaîne fonctionne contre un *vrai* provider, dans les
mêmes conditions que la prod.

**Modèle d'organisation côté provider** : pour chaque CloudProvider on
maintient une **org/team/account dédiée aux E2E Vauban**, séparée de la
prod, avec des creds dédiés.

```
provider     | org/team/account dédié    | creds dans .env.test
-------------+---------------------------+--------------------------------
infisical    | workspace vauban-e2e      | INFISICAL_TEST_WORKSPACE_ID
             | (Cloud Free tier)         | INFISICAL_TEST_API_TOKEN
             |                           | INFISICAL_TEST_ENDPOINT (optionnel, défaut Cloud)
github       | github.com/vauban-e2e     | GITHUB_TEST_PAT_READ
             |                           | GITHUB_TEST_PAT_ADMIN  (repo:admin)
vercel       | team vauban-e2e           | VERCEL_TEST_TEAM_ID
             |                           | VERCEL_TEST_ACCESS_TOKEN
supabase     | org vauban-e2e            | SUPABASE_TEST_ORG_REF
             |                           | SUPABASE_TEST_ACCESS_TOKEN
cloudflare   | account vauban-e2e        | CLOUDFLARE_TEST_ACCOUNT_ID
             |                           | CLOUDFLARE_TEST_API_TOKEN
…            | …                         | …
```

Le fichier **`.env.test`** est :
- gitignored (jamais commit),
- maintenu par chaque dev en local (ou partagé via le SecretManager
  d'équipe Vauban — *eat your own dog food*),
- en CI : injecté depuis les GitHub Actions secrets de `vauban-e2e` au
  début du job E2E.

**Conventions de nommage des ressources transitoires** créées en cours
de test :

```
vauban-e2e-<testfile-hash6>-<run-uuid8>
```

ex: `vauban-e2e-a3f1c2-9b2dc714`. Permet (a) de cleaner ciblé après
chaque test, (b) au sweeper de retrouver les orphelins.

**Cycle de vie d'un test E2E qui crée une ressource :**

```
1. test setup     : load .env.test, génère run-uuid
2. test body      : provision via Admin → resource créée chez provider
                    + row CRM persistée
3. test asserts   : metadata, sealed_blob, RLS, audit row
4. afterEach      : destroyChild côté provider + DELETE Vauban
                    (idempotent : si crashe avant cleanup, le sweeper
                     finit le job)
5. afterAll       : si tous les afterEach OK, no-op
```

**Sweeper** (cron CI nightly) :
- Liste les ressources `vauban-e2e-*` côté chaque provider, supprime
  celles de plus de 24h.
- Exécuté hors heures ouvrées, alerte sur Telegram si > N orphelins
  (signal de crashs E2E non-cleanés).

**Scénarios E2E couverts** (un fichier par scénario) :
- Register OrgResource (kind `<provider>-org`) → health check → unseal.
- Register OrgResourceAdmin → register OrgResource → provision
  ProjectResource via Admin → assert provider-side création effective.
- Rotation Access en `admin-mediated` → assert ancien token invalidé
  côté provider, nouveau token valide.
- Export `.env` pour `(project, variant)` → file téléchargé, lignes
  attendues présentes, secrets en placeholder pour les blobs non-decryptables.
- RBAC : un `member` non-admin ne peut pas PATCH ; assert 403.
- Re-seal flow : ajouter un member, assert `recipients_stale=true` sur
  les blobs, déclencher re-seal, assert blobs déchiffrables par le new member.

**Cost & rate-limit** : chaque scénario est conçu pour 1 cycle
create→destroy par run. Pas de boucles. La somme des coûts attendue
est négligeable (les providers ciblés ont des tiers free pour le test).

### 12.4 Structural

- Test qui parse le schéma TS de `@vauban/crm-catalog` et refuse tout
  drift de signature de `ResourceKind` / `OrgResourceAdminKind` non
  documenté dans `docs/decisions/`.
- Test qui vérifie que tout `kindClass='org-admin'` Kind déclare au
  moins un `manages: [...]` non-vide.
- Test qui vérifie que tout Kind déclare un `rotationMethod` valide.

## 13. Plan de cutover (rip & replace)

Greenfield : aucune migration de données, aucun dual-write. La séquence :

1. **Spec OK** (ce document, validé en review).
2. **Branche `agent/cloud-resource-manager-greenfield`** depuis `staging`.
3. **DB** : nouvelle migration `1000_provider_resource_manager.sql` qui :
   - drop `org_services`, `project_services`, `credential_blobs`,
     `service_origin`, `service_status`, `service_connection_status`,
     `project_manifests.services`,
   - drop tout RLS attaché,
   - crée les tables §3.1 (`secret_managers`, `resources`,
     `resource_access`, `mcp_configs`).
4. **Core (`@vauban/core`)** : retirer `credentials/`, `plugin/service.ts`,
   `plugin/host.ts`, `registry/*` ; ajouter `crm/` (interfaces §5).
5. **Catalogue (`@vauban/crm-catalog`)** : nouveau package, livre les
   ResourceKinds (Org / Project / OrgAdmin) pour github, vercel,
   supabase-cloud.
6. **Plugins legacy** : supprimer `plugin-service-*` et `plugin-host-*`
   (leur contenu est récrit dans `@vauban/crm-catalog`).
7. **Web `app/api/crm/v1/*`** : endpoints §6.
8. **Web UI `app/organizations/[slug]/resources/*`** : remplacement total
   (purger l'ancien dossier `services/` en début de PR).
9. **Runner** : adapter le consumer côté Runner (lecture `resource_access`,
   plus de `credential_blobs`). Coding Sessions inchangées côté lifecycle.
10. **Suppression** des routes legacy : `/api/organizations/[slug]/services/*`,
    `/api/runner/credentials/*`, `org-service-env-export.ts`,
    `project-env-export.ts`.
11. **E2E** vert avant merge dans `staging`.

Pas de feature flag, pas de période de coexistence. Branche merge en une
PR (potentiellement énorme) ou en train de 2-3 PRs si ça aide la revue,
mais **toujours** sans dual-write — chaque PR laisse le repo buildable.

## 14. Décisions figées et points restants

### 14.1 Décisions figées (référence rapide)

- **Admin cascade** : `ON DELETE SET NULL` sur `admin_resource_id`.
  Banner "no admin attached — rotation manuelle via setupDocs" sur
  l'enfant orphelin.
- **MCPConfig retention** : un seul snapshot vivant par
  `(org, project?, variant?)` (UNIQUE + UPSERT). Pas d'historique en
  table ; pour audit voir `audit_log`.
- **Stale re-seal UX** : pour le new member, "Contacter un admin pour
  qu'il active votre accès" sur les Resources où il n'a 0 blob
  déchiffrable. Pas de blocage. Pour les admins, banner "X access blobs
  need re-sealing" avec action explicite.
- **Variant** : NULL uniquement (jamais string vide).
- **Cross-org** : strictement org-bound. Un Admin d'org A ne peut pas
  provisionner pour org B.
- **Adoption** : `listChildren` est dans le contrat (§5.1). Le flow
  d'adoption = même que provisioning, en sautant `createChild`.
- **Multi-provider Resource** : impossible par construction (1 row = 1
  `provider_name`).
- **Per-device keypair** : non, 1 keypair par user, `wrapped_sk`
  redistribuée via Vauban (§4.1).
- **DEK envelope** : non en v1, direct multi-recipient suffit jusqu'à
  ~50 users × ~500 resources (§4.3).

### 14.2 Points encore ouverts pour la suite

- **Adoption d'un Admin existant** : si tu changes de PAT admin (ex:
  l'ancien expire), comment "transférer" les enfants au nouvel Admin ?
  v1 : DELETE old Admin → enfants orphelins → register new Admin →
  bulk PATCH des enfants pour set `admin_resource_id=new`. UI à
  designer. Hors-scope spec, à traiter en implémentation.
- **Onboarding du tout premier user** : qui re-seal pour lui s'il est
  seul ? v1 : il est admin par construction (créateur de l'org),
  ses propres puts incluent sa pubkey. Cas dégénéré uniquement si on
  invite un second user *avant* d'avoir mis quoi que ce soit dans
  l'org — alors aucun blob à re-sealer, OK trivialement.

---

_Date : 2026-05-21. Auteur : rpelissier + Claude (drafting). Statut :
draft pour review._
