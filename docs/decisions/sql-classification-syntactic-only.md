---
title: Classification SQL d'execute_sql — syntaxique uniquement (semantic escalation hors scope MVP)
status: superseded
date: 2026-06-11
superseded-by: pivot-to-risk-based-model
superseded-date: 2026-06-15
---

# Classification SQL d'`execute_sql` — syntaxique uniquement

> **⚠️ SUPERSEDED 2026-06-15** — En v4, `supabase__execute_sql`
> devient **strict read-only** géré par Postgres lui-même
> (`SET TRANSACTION READ ONLY` ou role `pg_read_all_data`). Toutes les
> mutations passent par les tools API granulaires (13 tools data-plane
> déjà shipped). La classification SQL parser disparait. Cf.
> [[gateway-risk-model]] §7.2 #2.

## Contexte

`supabase__execute_sql` est un passthrough générique sur la Supabase
Management API (`POST /v1/projects/{ref}/database/query`). Le caller fournit
une query SQL arbitraire, on la forward telle quelle.

Précédemment (jusqu'au 2026-06-11), le tool était classifié statiquement
`db/rows:read` "par convention" — la description disait littéralement
"INSERT/UPDATE/DELETE will land but the role is meant for SELECT". C'était
une faille : un token avec `db/rows:read` pouvait exécuter `DROP TABLE
users` et l'audit log l'enregistrait comme "read".

La passe du 2026-06-11 ajoute un classifier `sql-classify.ts` qui parse la
query (sanitization des strings / commentaires / dollar-quoted bodies, split
sur `;`, identification du verbe leader de chaque statement) et route vers
le ring approprié du plane `db` :

- `SELECT / WITH / EXPLAIN / SHOW / VALUES` → `rows:read`
- `INSERT / UPDATE / DELETE / MERGE / TRUNCATE / COPY` → `rows:write`
- `CREATE/DROP/ALTER {TABLE|INDEX|VIEW|FUNCTION|...}` → `tables:write`
- `CREATE/DROP POLICY` + `GRANT/REVOKE` + `ALTER TABLE … ROW LEVEL SECURITY`
  → `rls:write`
- `CREATE EXTENSION` + `ALTER SYSTEM` + `VACUUM` + `SET` → `project:write`
- Verbe inconnu → `project:write` (paranoïaque, force human gate)
- Multi-statement → strictest wins (rank max ; write trumps read)

Ce classifier ferme le trou évident. Mais il reste une classe d'attaques
que **ni le classifier actuel, ni un parser PostgreSQL réel (libpg_query
etc.), ni aucune approche purement statique** ne peut détecter — parce
qu'elle est sémantique, pas syntaxique. Cet ADR documente explicitement
ce trou pour qu'on n'ait pas l'illusion d'une couverture qu'on n'a pas.

## Décision

`sql-classify.ts` (regex-based, sans dépendance externe) est la couche de
classification d'`execute_sql` pour le MVP. La sécurité contre l'escalation
sémantique est **explicitement déléguée** :

1. Au **role DB** côté Supabase (aujourd'hui = ~superuser via Mgmt API PAT —
   limitation assumée pour le MVP, voir _Conséquences_).
2. À l'**audit log** + alerting post-facto.
3. Au **human gate** sur tout write env-less ou `@prod` (seed policy
   `*:*:*:write:* → confirm`).

Pas de parser PG réel introduit en MVP : le coût (dépendance native ou WASM
~3-5 Mo) ne fixe pas la classe sémantique, donc la valeur marginale est
faible. À reconsidérer si on bascule sur (2) ci-dessous.

## Conséquences

### Ce que le classifier syntaxique couvre

- Attaques évidentes : `DROP TABLE`, `DELETE FROM`, `GRANT`, `ALTER SYSTEM`
  visibles dans le top-level de la query.
- Multi-statement obfuscation : `select 1; drop table users;` →
  `tables:write` (joinReq prend le strictest).
- Semicolon dans string literal : `select 'a; drop table users';` →
  `rows:read` (strip blanchit le contenu de la string avant split).
- Keyword dans commentaire : `select 1; -- drop table users` → `rows:read`.
- Dollar-quoted body : `create function f() as $$ drop table x $$ language sql;`
  → `tables:write` (envelope CREATE FUNCTION classée correctement ; body
  blanchi pour la detection).
- `ALTER TABLE … ROW LEVEL SECURITY` : routé sur `rls:write` (pas
  `tables:write`) via une regex spécifique.

### Ce que le classifier **ne** couvre **pas** (et ne peut pas, même avec un parser PG réel)

| Vecteur                                          | Exemple                                                                                   | Pourquoi statiquement indétectable                                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Side effects dans fonction appelée par SELECT    | `select my_archive_orders();` où la fonction fait `DELETE FROM orders` en interne         | Parser voit l'appel ; le corps de la fonction vit en DB, hors de la query parsée.                                                               |
| `SECURITY DEFINER` privilege escalation          | `select admin_op();` où `admin_op` est `SECURITY DEFINER` owned par postgres              | Le parser ne sait pas qui owne la fonction ni le role d'exécution.                                                                              |
| `INSTEAD OF` triggers sur views                  | `select * from v_users;` où `v_users` a un trigger INSTEAD OF                             | Look comme un read pur ; déclenche du code arbitraire à l'exécution.                                                                            |
| Generated columns / DEFAULT expressions          | INSERT/SELECT touchant une colonne dont l'expression appelle une fonction à side effects  | Le parser voit l'expression, pas son comportement.                                                                                              |
| `DO` blocks avec `EXECUTE` dynamique             | `do $$ begin execute 'drop table u'; end $$`                                              | Le parser voit `DO`, peut voir `EXECUTE`, mais le string passé est runtime. (On classe `DO` en `rows:write` conservateur — ne couvre pas tout.) |
| `EXECUTE format(...)` dans une fonction PL/pgSQL | Idem, planqué dans une procédure stockée                                                  | Construction de SQL à l'exécution.                                                                                                              |
| Extensions PG dangereuses                        | `select pg_terminate_backend(pid)`, `pg_read_file()`, `pg_ls_dir()`, `pg_advisory_lock()` | Parser voit l'appel ; ne sait pas que ce sont des escape hatches OS / cluster.                                                                  |
| Resource exhaustion / DoS                        | CTE récursive infinie, cartesian product 10⁹ rows                                         | Pas un problème de capability — un problème de ressource.                                                                                       |

Le **point fondamental** : dès qu'un statement appelle une fonction (et en
PG, n'importe quelle expression peut le faire — `where col = my_fn()`,
`select fn()`, default values, generated columns…), le classifier perd la
trace. La frontière "syntaxique" passe par cet appel ; ce qu'il y a derrière
est invisible.

### Vraies couches de défense (stack complet — état actuel + roadmap)

| #   | Couche                                                                     | État Vaubaan v0              | Ce qui manque                                                      |
| --- | -------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| 1   | Capability gate sur classification syntaxique                              | ✅ implémenté (ce PR)        | rien                                                               |
| 2   | DB role least-privilege                                                    | ❌ Mgmt API PAT = ~superuser | router execute_sql via data plane + role applicatif + GRANTs + RLS |
| 3   | Function allow-list (refus des `pg_*` ésotériques + functions non-listées) | ❌                           | dictionnaire à maintenir per-project                               |
| 4   | Read-replica pour les `rows:read`                                          | ❌ (option Supabase Pro)     | provisioning + routing dual plane                                  |
| 5   | Audit + alerting post-facto                                                | ✅ audit_log existant        | règles d'alerting (gros DELETE, DROP, etc.)                        |
| 6   | Statement timeouts + resource limits côté DB                               | partiel (default PG)         | tuning per-project                                                 |

(2) est le vrai durcissement contre l'escalation sémantique : si le role
applicatif n'a pas le GRANT pour `DELETE FROM users`, même une fonction
SECURITY DEFINER ne peut pas l'exécuter (sauf si le DEFINER lui-même a les
droits — d'où l'importance du least-privilege jusqu'en haut). Mais c'est un
refactor archi : il faut basculer execute_sql sur la data plane (PostgREST
ou pg direct) avec un role distinct du Mgmt API.

### Acceptation explicite

En MVP, on accepte que :

- Un caller portant `db/rows:read@prod` qui invoque
  `select archive_old_orders()` peut déclencher un DELETE caché — l'audit
  log le tagge `rows:read` parce que c'est ce que dit le syntaxique.
- La défense en pratique repose sur (a) le human gate sur tous les writes
  par seed policy, (b) le fait que les fonctions à side-effects sont
  écrites par les opérateurs eux-mêmes (pas par des attaquants externes),
  (c) l'audit log post-facto.
- Si un opérateur définit une fonction "innocente en apparence, malveillante
  en interne", Vaubaan ne la détectera pas. C'est un problème de
  gouvernance interne du tenant, pas du gateway.

## Alternatives rejetées

### A. Pas de classification — un seul `db:write` brutal

Tout `execute_sql` classé `db:write` (le pire des cas). Avantage : zéro
risque de mis-classification. Inconvénient : tout SELECT pop le human gate
→ inutilisable pour les agents de debug / analytics qui font des reads
toute la journée. Rejeté.

### B. Parser PG réel (libpg_query-node / pg-query-parser)

Avantage : 100% correct sur le verbe / les CTEs / les sub-queries. Inconvénient :

- Dépendance native (binding C) ou WASM ~3-5 Mo
- **Ne fixe pas la classe sémantique** (cf. tableau ci-dessus) — la valeur
  marginale est faible
- Le regex-based actuel a 42 tests passants couvrant tous les patterns
  importants

Rejeté pour le MVP. À reconsidérer si on bascule sur (2) et qu'on veut une
classification très précise pour générer des GRANTs ciblés.

### C. Allow-list de patterns SQL acceptés

Refuser tout ce qui ne match pas une whitelist (`SELECT`, `INSERT INTO known_table`, etc.).
Avantage : très strict. Inconvénient : tue le use case "un dev veut faire un
`alter table add column` ad-hoc en preview" — qui est exactement pourquoi on
n'a pas voulu filtrer ("si Supabase l'expose, un dev va en avoir besoin un
jour"). Rejeté.

### D. Read-only via data plane + write via Mgmt API

Router les SELECT via une connexion data-plane avec role limité, et garder
les writes sur Mgmt API. Avantage : ferme la classe sémantique pour les
reads. Inconvénient : 2 chemins d'exécution à maintenir + provisioning du
role data-plane par projet. À explorer après MVP — cf. handbook
[[supabase-provider]] (à créer) pour la roadmap.

## Références

- Code : `packages/providers/supabase/src/sql-classify.ts`,
  `packages/providers/supabase/src/classify.ts`,
  `packages/providers/supabase/tests/unit/sql-classify.test.ts` (42 tests).
- Spec : `docs/spec/gateway-capability-model.md` §3 (capability tuple), §5
  (policy layer + human gate).
- ADRs voisins : [[escalation]],
  [[vercel-augment-with-rest-tools]] (pattern de wrapping REST custom),
  [[mcp-only-mvp-scope.md]].
