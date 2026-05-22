---
title: RLS minimaliste — 2 rôles (member / admin), granularité fine via crypto
status: accepted
date: 2026-05-21
author: rpelissier
tracks: []
---

# RLS minimaliste : 2 rôles ; granularité fine via la recipient list crypto

## Contexte

Un système multi-tenant avec secrets doit articuler deux niveaux de
contrôle d'accès :

1. **Le plan RBAC SQL** (qui peut lire/écrire quelle row) — porté par
   les policies Postgres RLS, vérifié par la DB à chaque query.
2. **Le plan crypto** (qui peut déchiffrer quel ciphertext) — porté par
   la recipient list dans le sealed_blob multi-recipient (§4.3).

L'erreur classique est de tout faire porter au plan RBAC :
`policy_for_blob_X(user_Y) = role_grant(...)` avec des dizaines de
combinaisons (roles : viewer/dev/admin/owner ; portées :
org/project/resource/access). Résultat : une matrice de policies SQL
ingérable, des bugs ("Bob voit le repo backend alors qu'il devrait
pas") et un drift inévitable avec le code applicatif.

La spec §3.3, §4.4 et §8 imposent une autre architecture : RBAC SQL
volontairement plate, granularité fine portée par la crypto.

## Décision

Au niveau Postgres RLS, **exactement deux rôles** par organization :

| Rôle     | Lecture                         | Écriture       |
| -------- | ------------------------------- | -------------- |
| `member` | toutes les rows métier de l'org | rien           |
| `admin`  | toutes les rows métier de l'org | toutes les ops |

Stockage : `public.org_members(organization_id, user_id, role text
check (role in ('member', 'admin'))` (cf.
`supabase/migrations/1000_provider_resource_manager.sql`).

Les helpers `public.is_org_member(uuid)` et `public.is_org_admin(uuid)`
sont des fonctions `security definer` cachées de `public` (granted only
to `authenticated`) — chaque policy RLS les invoque pour son check.

La granularité fine "qui voit en clair quoi" est **entièrement portée
par la recipient list** du sealed_blob (§4.4) :

- Un `member` peut _fetch_ tous les `sealed_blob` de son org (RLS lui
  donne le row).
- Il ne peut _déchiffrer_ que ceux où sa pubkey est listée comme
  recipient — point. Pas de policy "Bob exclu du blob X" : on
  l'exclut en ne mettant pas sa pubkey dans la recipient list au
  moment du seal.
- L'admin auteur du seal décide blob-par-blob qui est dans la liste,
  via le composant `<SealedInput>` qui présente la pubkey de chaque
  member candidate.

## Conséquences

### Positives

- **9 tables × 2 rôles = ~36 policies** (au lieu de 200+ pour un
  modèle multi-rôles). Lisible, auditable, testable.
- **Pas de drift code/SQL** : la décision "Bob ne voit pas le project
  backend" se prend une fois (au seal) et est tenue par la
  cryptographie. Un changement de code applicatif ne peut pas la
  défaire.
- **Aligné sur la métaphore 1Password** : "Bob est dans le coffre
  org" ⇄ "Bob est member". L'admin choisit blob-par-blob qui voit
  quoi.
- **Découplage opérateur Vauban / opérateur org** : l'opérateur DB
  Vauban peut, en théorie, accorder R sur `resource_access` à
  n'importe qui — il n'aura toujours rien sans la sk d'un recipient.
  Le double-plan §4.0 est tenu structurellement.
- **Code applicatif simplifié** : les endpoints CRM n'ont pas à porter
  une notion de "filtre par projet visible à user X" — la RLS le fait
  pour l'inventaire, la crypto le fait pour les valeurs.

### Négatives / contraintes

- **Pas de rôle "viewer" granulaire** : un member voit toute
  l'inventaire de son org (les rows `resources`, `resource_access`
  méta, `mcp_configs`). Si une org veut interdire à Bob de _même
  savoir_ qu'il existe un project `backend`, le modèle ne le permet
  pas. C'est un choix : la confidentialité est sur les valeurs (les
  secrets), pas sur les noms.
- **Le re-seal devient _le_ point de contrôle** : ajouter un member à
  une org sans re-seal lui donne accès uniquement aux blobs futurs.
  Spec §4.5 documente le banner UI "X blobs need re-sealing".
- **Audit fin de "qui a vu quoi" repose sur audit_log** : la SQL ne
  donne qu'un grain "qui a `select` sur la row" ; le grain crypto est
  porté par les entrées `audit_log` `action='access.read'`.
- **Granularité de révocation** : retirer Bob d'une org ⇒ il perd
  l'accès aux nouvelles versions, mais conserve mémoire de ce qu'il
  a déjà déchiffré. Pour révoquer réellement il faut _rotater_ le
  secret côté Provider (spec §4.5 last paragraph).

## Alternatives rejetées

### Multi-rôles fins (viewer / dev / lead / admin / owner)

Donne plus d'expressivité, mais :

- Explosion combinatoire des policies (chaque table × chaque rôle ×
  chaque action SELECT/INSERT/UPDATE/DELETE).
- Pose la question "qui crée un rôle / qui assigne un rôle ?" qui
  redemande de la RBAC dessus.
- N'aide _pas_ à résoudre le vrai problème (qui déchiffre quel
  cleartext) — qui reste en crypto.
- Aligné avec la culture du "RBAC pyramidal" enterprise dont on n'a
  pas l'usage en v1 (cibles : équipes 5-50 personnes).

### Project-level membership (table `project_members`)

Permettrait d'avoir un member d'org sans accès à un project. Mais :

- Casse l'invariant "Bob fetch tous les sealed_blob de l'org" (qui
  est nécessaire pour la simplicité de l'export `.env` côté browser).
- Sa fonction (cacher des projects à des members) est mieux portée
  par la crypto : si Bob n'est pas recipient des blobs de
  `backend`, il les voit comme placeholders → effet équivalent.
- Reportable en v2 si une org demande explicitement "je ne veux même
  pas qu'il voie le nom du project".

### RLS désactivée + checks applicatifs

Simplifie au prix de la sécurité d'isolation : un bug applicatif
("oublié le `where org_id=…`") ⇒ leak cross-org. Disqualifié par §10
(security stance).

### ABAC (attributs sur les rows, evaluation runtime)

Trop générique, lourd à exprimer en RLS Postgres (qui veut
fondamentalement des prédicats SQL stables). Pas la culture
opérationnelle Vauban.

## Références

- `docs/spec/cloud-resource-manager.md` §3.3, §4.0, §4.4, §8.
- `supabase/migrations/1000_provider_resource_manager.sql` (policies
  matérialisées).
- ADR `crypto-libsodium-sealed-box-multi-recipient.md` (côté plan crypto).
