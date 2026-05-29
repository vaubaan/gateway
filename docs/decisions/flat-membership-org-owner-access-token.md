---
title: Flat membership + Org owner + Access Token (renaming Bot)
status: accepted
date: 2026-05-26
supersedes: rbac-org-role-bot-project
tracks:
  - docs/spec/vaubaan-gateway.md
  - supabase/migrations/0001_init.sql
---

# Flat membership + Org owner + Access Token (renaming Bot)

## Contexte

Le modèle initial (cf. [[rbac-org-role-bot-project]]) introduisait deux choix
qui se sont avérés à reconsidérer après usage :

1. **Deux rôles humains org (`member` / `admin`)** : le `member` n'avait que
   du read sur l'audit et les projects ; toutes les actions utiles (créer
   un project, connecter un provider, créer un Bot) exigeaient `admin`. Dans
   une équipe qui fait confiance à ses membres (les équipes Vauban-style),
   ce filtre génère de la friction sans gain de sécurité — un membre malveillant
   peut déjà observer tout l'audit, donc la séparation read/write est cosmétique.

2. **Bot** comme nom de l'objet porteur de l'`api_key`. Le mot présume que le
   consommateur est un agent LLM. Mais une `vbn_live_...` peut tout aussi bien
   être posée dans un script CI, un cron humain, un curl manuel. Le naming
   présume de l'usager là où on n'a pas à le faire.

Par ailleurs, sans rôle `admin`, il faut un mécanisme pour empêcher
l'auto-éjection accidentelle du dernier humain capable d'administrer l'org.

## Décision

**Modèle plat avec owner protégé.** Trois changements coordonnés :

### 1. Drop des rôles `member` / `admin`

- Colonne `org_members.role` supprimée.
- Toute personne dans `org_members` a un accès complet RW sur tout le contenu
  de l'org (projects, bindings, access_tokens, roles custom, members, audit).
- Les RLS perdent toutes les vérifications `is_org_admin()` (fonction
  supprimée) ; remplacées par `is_org_member()` qui était déjà la base.

### 2. Owner par-org via `organizations.owner_id`

- Colonne `owner_id uuid not null references auth.users(id)` ajoutée à
  `organizations`.
- 1 owner unique par org (enforced par le type colonne — pas besoin
  d'index partiel sur `org_members.role = 'owner'`).
- Trigger `enforce_owner_is_member` insère l'owner dans `org_members` si
  absent, à chaque INSERT ou UPDATE d'`owner_id`.
- À la création d'org, le créateur devient owner ; le trigger gère
  l'inscription dans `org_members`.

### 3. `Bot` → `AccessToken`

- Tables : `bots` → `access_tokens`, `bot_roles` → `access_token_roles`.
- FK : `audit_log.bot_id` → `audit_log.access_token_id`.
- Routes : `/api/v1/bots/*` → `/api/v1/tokens/*`.
- Types : `BotContext` → `AccessTokenContext`, `loadBotForAuth` →
  `loadAccessTokenForAuth`, `loadBotContext` → `loadAccessTokenContext`.
- UI : pages `bots/` → `tokens/`, labels « Bot » → « Access token »,
  placeholder neutre (`claude-dev` → `ci-deploy`).

### Protection de l'owner

- **DELETE de l'owner refusé** : la RLS `org_members delete for members
except owner` empêche un member (y compris l'owner lui-même) de retirer
  l'owner tant qu'il porte ce statut.
- **Transfert obligatoire avant suppression** : nouvelle route
  `POST /api/v1/orgs/:slug/transfer-ownership` body `{ newOwnerId }`. Seul
  l'owner courant peut la call (`requireOrgOwner`). Le `newOwnerId` doit
  déjà être member de l'org. L'update de `organizations.owner_id` est
  servi par RLS via `is_org_owner()` ; le trigger garantit l'inscription
  du nouvel owner dans `org_members`.
- **Owner et member** : un owner n'a aucun privilège supplémentaire en
  termes de RW vs un autre member. Sa seule différence : il est protégé
  contre le DELETE et il est le seul à pouvoir transférer.

## Conséquences

**Positives :**

- **Mental model 1-tier.** Plus d'ambiguïté "qui peut quoi" — soit tu es
  dans l'org, soit tu n'es pas. Les RLS sont plus simples (suppression de
  toutes les policies `write for admins`).
- **Vocabulaire honnête.** `access_token` n'engage rien sur l'usager
  (agent, humain, CI). Les libellés UI suivent ("New access token",
  "Token name", placeholder `ci-deploy`).
- **Pas d'auto-lockout.** L'owner ne peut pas se retirer par accident ;
  pour partir il doit explicitement transférer, ce qui est une action
  délibérée par construction.
- **Modèle aligné GitHub/Linear/Vercel.** Un owner unique avec transfert
  explicite est la convention SaaS dominante.

**Négatives / à surveiller :**

- **Pas de granularité humaine.** Un member peut révoquer une connexion
  provider, supprimer un projet, supprimer un access_token. Pour les orgs
  avec un mix de personnes "confiance" et "stagiaire externe", ce sera
  insuffisant — il faudra alors réintroduire un rôle "viewer" (read-only),
  pas l'inverse (ne pas remettre admin/member).
- **Bus factor de l'owner.** Si l'owner est inaccessible (compte clos,
  parti de la boîte), il faut un mécanisme support (escalade Vaubaan) pour
  forcer le transfert. À documenter dans le runbook ops quand on l'écrit.

## Alternatives rejetées

- **Garder `role` avec valeurs `member` / `owner`.** Rejeté : un boolean
  encodé sur une colonne text invite à des bugs (typos, défauts). Avec
  `organizations.owner_id` FK, le typage Postgres + la contrainte
  référentielle garantissent l'invariant "1 owner par org" sans logique
  applicative.
- **Owner = simple flag computed (`first member added_at`).** Rejeté :
  fragile (le créateur peut quitter, on perd la trace de qui est owner).
  Une colonne explicite est durable et auditable.
- **Garder `Bot` comme nom interne, exposer `Access token` en UI.** Rejeté :
  l'incohérence vocabulaire UI/code/DB est une source de friction à long
  terme. Renommer partout coûte un commit ; vivre avec deux noms coûte tous
  les jours.
- **Rôle `admin` conservé pour les actions destructives (DELETE org, kick
  member).** Rejeté : ces actions sont rares et l'erreur humaine y est rare.
  L'owner-protection + le confirm dialog UI suffisent au MVP. Si le pattern
  ressurgit (incidents répétés), on pourra réintroduire un check `owner-only`
  ciblé sur les actions destructives spécifiques sans réintroduire un tier.
